import type { IPointData } from "pixi.js";
import { rpcClient } from "typed-rpc";
import {
   compressSave,
   getGameOptions,
   getGameState,
   notifyGameStateUpdate,
   saveGame,
   serializeSave,
} from "../Global";
import type { Building } from "../definitions/BuildingDefinitions";
import type { IUnlockableDefinition } from "../definitions/ITechDefinition";
import type { Resource } from "../definitions/ResourceDefinitions";
import { client } from "../rpc/RPCClient";
import { isSteam } from "../rpc/SteamClient";
import { WorldScene } from "../scenes/WorldScene";
import {
   HOUR,
   bytesToBase64,
   clamp,
   filterOf,
   forEach,
   hasFlag,
   isEmpty,
   keysOf,
   pointArrayToXy,
   pointToXy,
   round,
   safeAdd,
   safePush,
   shuffle,
   sizeOf,
   xyToPoint,
   xyToPointArray,
} from "../utilities/Helper";
import { srand } from "../utilities/Random";
import { Singleton } from "../utilities/Singleton";
import { Vector2, v2 } from "../utilities/Vector2";
import { L, t } from "../utilities/i18n";
import { compress, decompress } from "../workers/Compress";
import {
   IOCalculation,
   addResources,
   addTransportation,
   canBeElectrified,
   deductResources,
   filterResource,
   filterTransportable,
   getAvailableResource,
   getAvailableWorkers,
   getBuilderCapacity,
   getBuildingCost,
   getBuildingValue,
   getMarketPrice,
   getPowerRequired,
   getScienceFromWorkers,
   getStockpileMax,
   getStorageFor,
   getStorageRequired,
   getWarehouseIdleCapacity,
   getWorkersFor,
   hasEnoughResources,
   isNaturalWonder,
   isSpecialBuilding,
   isTransportable,
   totalMultiplierFor,
   useWorkers,
} from "./BuildingLogic";
import { Config } from "./Config";
import { GameFeature, hasFeature } from "./FeatureLogic";
import { GameState, type ITransportationData } from "./GameState";
import { calculateHappiness } from "./HappinessLogic";
import {
   clearIntraTickCache,
   getBuildingIO,
   getStorageFullBuildings,
   getXyBuildings,
   unlockedResources,
} from "./IntraTickCache";
import { onBuildingComplete, onBuildingProductionComplete } from "./LogicCallback";
import { getAmountInTransit } from "./ResourceLogic";
import type { Multiplier } from "./TickLogic";
import { CurrentTickChanged, EmptyTickData, Tick, freezeTickData } from "./TickLogic";
import type {
   IBuildingData,
   IMarketBuildingData,
   IResourceImportBuildingData,
   IWarehouseBuildingData,
} from "./Tile";
import { MarketOptions, WarehouseOptions } from "./Tile";

let timeSinceLastTick = 0;

export function tickEveryFrame(gs: GameState, dt: number) {
   timeSinceLastTick = Math.min(timeSinceLastTick + dt, 1);
   const worldScene = Singleton().sceneManager.getCurrent(WorldScene);
   if (worldScene) {
      for (const xy in gs.tiles) {
         const tile = gs.tiles[xy];
         if (tile.building != null) {
            worldScene.getTile(xy)?.update(gs, dt);
         }
      }
      worldScene.updateTransportVisual(gs, timeSinceLastTick);
   }
}

export function shouldTick(): boolean {
   return isSteam() || document.visibilityState === "visible";
}

export function tickEverySecond(gs: GameState, offline: boolean) {
   // We should always tick when offline
   if (!offline && !shouldTick()) {
      return;
   }
   timeSinceLastTick = 0;

   Tick.current = freezeTickData(Tick.next);
   CurrentTickChanged.emit(Tick.current);
   Tick.next = EmptyTickData();
   clearIntraTickCache();

   forEach(gs.unlockedTech, (tech) => {
      tickTech(Config.Tech[tech]);
   });

   forEach(gs.greatPeople, (person, level) => {
      const greatPerson = Config.GreatPerson[person];
      greatPerson.tick(greatPerson, level, false);
   });

   forEach(getGameOptions().greatPeople, (person, v) => {
      const greatPerson = Config.GreatPerson[person];
      greatPerson.tick(greatPerson, v.level, true);
   });

   tickPrice(gs);
   tickTransportations(gs);
   tickTiles(gs, offline);

   Tick.next.happiness = calculateHappiness(gs);
   const { scienceFromWorkers } = getScienceFromWorkers(gs);
   safeAdd(Singleton().buildings.Headquarter.building.resources, "Science", scienceFromWorkers);

   ++gs.tick;

   if (!offline) {
      notifyGameStateUpdate();
      if (gs.tick % 5 === 0) {
         saveGame(false).catch(console.error);
         Singleton().heartbeat.update(serializeSave());
      }
   }
}

function tickTech(td: IUnlockableDefinition) {
   td.unlockBuilding?.forEach((b) => {
      Tick.next.unlockedBuildings[b] = true;
   });
   forEach(td.buildingMultiplier, (k, v) => {
      addMultiplier(k, v, t(L.SourceResearch, { tech: td.name() }));
   });
   forEach(td.globalMultiplier, (k, v) => {
      Tick.next.globalMultipliers[k].push({
         value: v,
         source: t(L.SourceResearch, { tech: td.name() }),
      });
   });
}

function tickTransportations(gs: GameState) {
   const mah = Tick.current.specialBuildings.MausoleumAtHalicarnassus
      ? Singleton().grid.xyToPosition(Tick.current.specialBuildings.MausoleumAtHalicarnassus)
      : null;
   forEach(gs.transportation, (xy, queue) => {
      gs.transportation[xy] = queue.filter((transport) => {
         tickTransportation(transport, mah);
         // Has arrived!
         if (transport.ticksSpent >= transport.ticksRequired) {
            const building = gs.tiles[transport.toXy].building;
            if (building) {
               safeAdd(building.resources, transport.resource, transport.amount);
            }
            return false;
         }

         return true;
      });
   });
}

function tickTransportation(transport: ITransportationData, mah: IPointData | null) {
   // TODO: This needs to be double checked when fuel is implemented!
   if (isTransportable(transport.fuel)) {
      transport.ticksSpent++;
      transport.hasEnoughFuel = true;
      return;
   }

   transport.currentFuelAmount = transport.fuelAmount;
   if (mah) {
      const position = Vector2.lerp(
         transport.fromPosition,
         transport.toPosition,
         transport.ticksSpent / transport.ticksRequired,
      );
      if (v2(position).subtractSelf(mah).lengthSqr() <= 200 * 200) {
         transport.currentFuelAmount = 0;
      }
   }

   if (getAvailableWorkers(transport.fuel) >= transport.currentFuelAmount) {
      useWorkers(transport.fuel, transport.currentFuelAmount, null);
      transport.ticksSpent++;
      transport.hasEnoughFuel = true;
   } else {
      transport.hasEnoughFuel = false;
   }
}

function isBuildingOrUpgrading(b: IBuildingData): boolean {
   return b.status === "building" || b.status === "upgrading";
}

function tickTiles(gs: GameState, offline: boolean) {
   const tiles = keysOf(getXyBuildings(gs)).sort((a, b) => {
      const buildingA = gs.tiles[a].building!;
      const buildingB = gs.tiles[b].building!;
      if (isBuildingOrUpgrading(buildingA) && !isBuildingOrUpgrading(buildingB)) {
         return -1;
      }
      if (isBuildingOrUpgrading(buildingB) && !isBuildingOrUpgrading(buildingA)) {
         return 1;
      }
      const diff = gs.tiles[b].building!.priority - gs.tiles[a].building!.priority;
      if (diff !== 0) {
         return diff;
      }
      return (Config.BuildingTier[buildingA.type] ?? 0) - (Config.BuildingTier[buildingB.type] ?? 0);
   });

   for (const tile of tiles) {
      tickTile(tile, gs, offline);
   }
}

function tickTile(xy: string, gs: GameState, offline: boolean): void {
   const tile = gs.tiles[xy];
   const building = tile.building!;
   if (building.status === "paused") {
      return;
   }
   if (isNaturalWonder(building.type) && !tile.explored) {
      return;
   }
   if (building.desiredLevel > building.level) {
      building.status = "upgrading";
   } else {
      building.desiredLevel = building.level;
   }
   if (building.status === "building" || building.status === "upgrading") {
      const cost = getBuildingCost(building);
      let completed = true;
      forEach(cost, (res, amount) => {
         const { total } = getBuilderCapacity(building, xy, gs);
         const amountArrived = building.resources[res] ?? 0;
         if (amountArrived >= amount) {
            // continue;
            return false;
         }
         if (amountArrived + getAmountInTransit(xy, res, gs) >= amount) {
            completed = false;
            // continue;
            return false;
         }
         completed = false;
         // Each transportation costs 1 worker, and deliver Total (=Builder Capacity x Multiplier) resources
         if (getAvailableWorkers("Worker") >= 1) {
            delete Tick.next.notProducingReasons[xy];
            useWorkers("Worker", 1, xy);
            transportResource(res, total, total, xy, gs);
            // break;
            return true;
         }
         Tick.next.notProducingReasons[xy] = "NotEnoughWorkers";
      });
      if (completed) {
         building.level++;
         if (building.status === "building") {
            building.status = "completed";
            const defaults = getGameOptions().buildingDefaults[building.type];
            if (defaults) {
               Object.assign(building, defaults);
            }
            onBuildingComplete(xy, gs);
         } else if (building.status === "upgrading" && building.level >= building.desiredLevel) {
            building.status = "completed";
         }
         forEach(cost, (res, amount) => {
            safeAdd(building.resources, res, -amount);
         });
      }
      return;
   }

   if (gs.unlockedTech.Banking && building.level >= 5) {
      safePush(Tick.next.tileMultipliers, xy, {
         storage: 1,
         source: t(L.SourceResearch, { tech: t(L.Banking) }),
      });
   }

   if (building.type === "Caravansary") {
      Tick.next.playerTradeBuildings[xy] = building;
   }

   if (isSpecialBuilding(building.type)) {
      Tick.next.specialBuildings[building.type] = xy;
   }

   Tick.next.totalValue += getBuildingValue(building);

   const input = filterTransportable(
      getBuildingIO(xy, "input", IOCalculation.Multiplier | IOCalculation.Capacity, gs),
   );
   const output = getBuildingIO(xy, "output", IOCalculation.Multiplier | IOCalculation.Capacity, gs);

   forEach(building.resources, (res, amount) => {
      if (amount <= 0) {
         return;
      }
      Tick.next.totalValue += Config.Resource[res].canPrice ? (Config.ResourcePrice[res] ?? 0) * amount : 0;
      safePush(Tick.next.resourcesByXy, res, xy);
      safePush(Tick.next.resourcesByGrid, res, xyToPointArray(xy));
   });

   const requiredDeposits = Config.Building[building.type].deposit;
   if (requiredDeposits) {
      let key: Resource;
      for (key in requiredDeposits) {
         if (!tile.deposit[key]) {
            Tick.next.notProducingReasons[xy] = "NotOnDeposit";
            return;
         }
      }
   }

   if (building.capacity <= 0) {
      Tick.next.notProducingReasons[xy] = "TurnedOff";
      return;
   }

   const worker = getWorkersFor(xy, { exclude: { Worker: 1 } }, gs);
   const inputWorkerCapacity = totalMultiplierFor(xy, "worker", 1, gs);
   const { total, used } = getStorageFor(xy, gs);

   //////////////////////////////////////////////////
   // Transport
   //////////////////////////////////////////////////

   let hasTransported = false;

   forEach(input, (res, val) => {
      const amount = val * building.stockpileCapacity;
      if (amount <= 0) {
         return;
      }
      if (used + getStorageRequired({ [res]: amount }) > total) {
         return;
      }

      let maxAmount = getStockpileMax(building) * amount;
      if ("resourceImports" in building) {
         const ri = building as IResourceImportBuildingData;
         maxAmount = ri.resourceImports[res]?.cap ?? 0;
      }

      if ((building.resources[res] ?? 0) + getAmountInTransit(xy, res, gs) > maxAmount) {
         return;
      }

      transportResource(res, amount, inputWorkerCapacity, xy, gs);
      hasTransported = true;
   });

   if (hasFeature(GameFeature.WarehouseUpgrade, gs) && "warehouseOptions" in building) {
      const warehouse = building as IWarehouseBuildingData;
      if (hasFlag(warehouse.warehouseOptions, WarehouseOptions.Autopilot)) {
         hasTransported = tickWarehouseAutopilot(warehouse, xy, gs);
      }
   }

   // If a building is a resourceImport type but has not transported, we consider it not working
   if ("resourceImports" in building && !hasTransported) {
      Tick.next.notProducingReasons[xy] = "NoActiveTransports";
   }

   //////////////////////////////////////////////////
   // Production
   //////////////////////////////////////////////////

   const tileVisual = offline ? null : Singleton().sceneManager.getCurrent(WorldScene)?.getTile(xy);

   if (building.type === "Market") {
      const market = building as IMarketBuildingData;
      let totalBought = 0;
      forEach(market.sellResources, (res) => {
         const amount = clamp(
            building.capacity * building.level * totalMultiplierFor(xy, "output", 1, gs),
            0,
            building.resources[res] ?? 0,
         );
         const buyResource = market.availableResources[res]!;
         const buyAmount = (amount * getMarketPrice(res, xy, gs)) / getMarketPrice(buyResource, xy, gs);
         if (used - amount + buyAmount > total) {
            Tick.next.notProducingReasons[xy] = "StorageFull";
            return;
         }
         safeAdd(building.resources, res, -amount);
         safeAdd(building.resources, buyResource, buyAmount);
         totalBought += buyAmount;
      });
      if (totalBought > 0) {
         tileVisual?.showText(`+${round(totalBought, 1)}`);
         onBuildingProductionComplete(xy, gs, offline);
      }
      return;
   }

   if ("resourceImports" in building) {
      return;
   }

   const hasEnoughStorage = isEmpty(output) || used + getStorageRequired(output) <= total;
   const hasEnoughWorker = getAvailableWorkers("Worker") >= worker.output;
   const hasEnoughInput = hasEnoughResources(building.resources, input);

   if (!hasEnoughWorker) {
      Tick.next.notProducingReasons[xy] = "NotEnoughWorkers";
      return;
   }

   if (!hasEnoughInput) {
      Tick.next.notProducingReasons[xy] = "NotEnoughResources";
      return;
   }

   if (!hasEnoughStorage) {
      const nonTransportables = filterResource(output, { canStore: false });
      if (sizeOf(nonTransportables) > 0) {
         const worker = getWorkersFor(
            xy,
            { include: filterOf(nonTransportables, (k) => k !== "Worker") },
            gs,
         );
         useWorkers("Worker", worker.output, xy);
         deductResources(building.resources, input);
         addResources(Tick.next.workersAvailable, nonTransportables);
         if (!isEmpty(filterTransportable(output))) {
            Tick.next.notProducingReasons[xy] = "StorageFull";
         }
      } else {
         Tick.next.notProducingReasons[xy] = "StorageFull";
      }
      return;
   }

   if (
      hasFeature(GameFeature.Electricity, gs) &&
      canBeElectrified(building.type) &&
      building.electrification > 0
   ) {
      building.electrification = clamp(building.electrification, 0, building.level);
      const requiredPower = getPowerRequired(building.electrification);
      if (getAvailableWorkers("Power") >= requiredPower) {
         useWorkers("Power", requiredPower, xy);
         safePush(Tick.next.tileMultipliers, xy, {
            source: t(L.Electrification),
            input: building.electrification,
            output: building.electrification,
         });
         Tick.next.electrified[xy] = building.electrification;
      }
   }

   useWorkers("Worker", worker.output, xy);
   deductResources(building.resources, input);
   forEach(output, (res, v) => {
      if (isTransportable(res)) {
         if (res === "Science") {
            safeAdd(Singleton().buildings.Headquarter.building.resources, res, v);
         } else {
            safeAdd(building.resources, res, v);
         }
         tileVisual?.showText(`+${round(v, 1)}`);
      } else {
         safeAdd(Tick.next.workersAvailable, res, v);
      }
   });
   onBuildingProductionComplete(xy, gs, offline);
}

function tickWarehouseAutopilot(warehouse: IWarehouseBuildingData, xy: string, gs: GameState): boolean {
   let capacity = getWarehouseIdleCapacity(warehouse);
   let hasTransported = false;
   const transportCapacity =
      totalMultiplierFor(xy, "worker", 1, gs) +
      Tick.current.globalMultipliers.transportCapacity.reduce((prev, curr) => prev + curr.value, 0);

   // Not enough workers, capacity will be capped
   if (Math.ceil(capacity / transportCapacity) > getAvailableWorkers("Worker")) {
      capacity = getAvailableWorkers("Worker") * transportCapacity;
   }

   // Clamp capacity by available storage
   const { total, used } = getStorageFor(xy, gs);
   capacity = clamp(capacity, 0, total - used);

   if (capacity <= 0) {
      return false;
   }
   const me = xyToPoint(xy);
   const result = getStorageFullBuildings(gs).sort(
      (a, b) =>
         Singleton().grid.distance(a.x, a.y, me.x, me.y) - Singleton().grid.distance(b.x, b.y, me.x, me.y),
   );
   const buildings = getXyBuildings(gs);
   for (let i = 0; i < result.length; i++) {
      const fromXy = pointToXy(result[i]);
      const building = buildings[fromXy];
      if (!building || fromXy === xy) {
         continue;
      }
      const resources = building.resources;
      const output = Config.Building[building.type].output;
      const candidates = keysOf(resources)
         .filter((r) => output[r])
         .sort((a, b) => resources[b]! - resources[a]!);
      for (let i = 0; i < candidates.length; i++) {
         const candidate = candidates[i];
         // Note: this is questionable. capacity are capped by transportCapacity first, without taking into account
         // the warehouse upgrade. This will result in less transports than it is. But fixing it is really complicated
         const upgradedTransportCapacity =
            Singleton().grid.distanceXy(fromXy, xy) <= 1 ? Infinity : Math.ceil(capacity / transportCapacity);
         if (resources[candidate]! >= capacity) {
            const workers = Math.ceil(capacity / upgradedTransportCapacity);
            useWorkers("Worker", workers, xy);
            resources[candidate]! -= capacity;
            addTransportation(candidate, capacity, "Worker", workers, fromXy, xy, gs);
            hasTransported = true;
            return hasTransported;
         }
         const amount = resources[candidate]!;
         const workers = Math.ceil(amount / upgradedTransportCapacity);
         useWorkers("Worker", workers, xy);
         resources[candidate]! -= amount;
         capacity -= amount;
         hasTransported = true;
         addTransportation(candidate, amount, "Worker", workers, fromXy, xy, gs);
      }
   }
   return hasTransported;
}

export function transportResource(
   res: Resource,
   amount: number,
   workerCapacity: number,
   targetXy: string,
   gs: GameState,
) {
   let amountLeft = amount;
   const grid = Singleton().grid;
   const targetPoint = xyToPointArray(targetXy);
   // We are out of workers, no need to run the expensive sorting!
   if (getAvailableWorkers("Worker") <= 0) {
      return;
   }
   const sources = Tick.current.resourcesByGrid[res]?.sort((point1, point2) => {
      return (
         grid.distance(point1[0], point1[1], targetPoint[0], targetPoint[1]) -
         grid.distance(point2[0], point2[1], targetPoint[0], targetPoint[1])
      );
   });
   if (!sources) {
      return;
   }
   for (let i = 0; i < sources.length; i++) {
      const pointArray = sources[i];
      const fromXy = pointArrayToXy(pointArray);
      const building = gs.tiles[fromXy].building;
      if (!building) {
         continue;
      }
      if (fromXy === targetXy) {
         continue;
      }

      const availableAmount = getAvailableResource(fromXy, res, gs);
      if (availableAmount <= 0) {
         continue;
      }

      let transportCapacity =
         workerCapacity +
         Tick.current.globalMultipliers.transportCapacity.reduce((prev, curr) => prev + curr.value, 0);

      if (
         hasFeature(GameFeature.WarehouseUpgrade, gs) &&
         (gs.tiles[fromXy].building?.type === "Warehouse" ||
            gs.tiles[targetXy].building?.type === "Warehouse")
      ) {
         const distance = Singleton().grid.distance(
            pointArray[0],
            pointArray[1],
            targetPoint[0],
            targetPoint[1],
         );
         if (distance <= 1) {
            transportCapacity = Infinity;
         }
      }

      if (availableAmount >= amountLeft) {
         const fuelAmount = Math.ceil(amountLeft / transportCapacity);
         const fuelLeft = getAvailableWorkers("Worker");
         if (fuelLeft >= fuelAmount) {
            building.resources[res]! -= amountLeft;
            addTransportation(res, amountLeft, "Worker", fuelAmount, fromXy, targetXy, gs);
         } else if (fuelLeft > 0) {
            const amountAfterFuel = (amountLeft * fuelLeft) / fuelAmount;
            building.resources[res]! -= amountAfterFuel;
            addTransportation(res, amountAfterFuel, "Worker", fuelLeft, fromXy, targetXy, gs);
         }
         // Here we return because either we've got all we need, or we run out of workers (no need to continue)
         return;
      }
      const amountToTransport = availableAmount!;
      const fuelAmount = Math.ceil(amountToTransport / transportCapacity);
      const fuelLeft = getAvailableWorkers("Worker");
      if (fuelLeft >= fuelAmount) {
         amountLeft -= amountToTransport;
         building.resources[res]! -= amountToTransport;
         addTransportation(res, amountToTransport, "Worker", fuelAmount, fromXy, targetXy, gs);
         // We continue here because the next source might have what we need
      } else if (fuelLeft > 0) {
         const amountAfterFuel = (amountToTransport * fuelLeft) / fuelAmount;
         building.resources[res]! -= amountAfterFuel;
         addTransportation(res, amountAfterFuel, "Worker", fuelLeft, fromXy, targetXy, gs);
         // We return here because we run out of workers (no need to continue)
         return;
      }
   }
}

export function addMultiplier(k: Building, multiplier: Multiplier, source: string) {
   let m = Tick.next.buildingMultipliers[k];
   if (m == null) {
      m = [];
   }
   m.push({ ...multiplier, source });
   Tick.next.buildingMultipliers[k] = m;
}

function getPriceId() {
   return Math.floor(Date.now() / HOUR);
}

export function convertPriceIdToTime(priceId: number) {
   return priceId * HOUR;
}

function tickPrice(gs: GameState) {
   const priceId = getPriceId();
   let forceUpdatePrice = false;
   if (gs.lastPriceUpdated !== priceId) {
      forceUpdatePrice = true;
      gs.lastPriceUpdated = priceId;
   }
   const resources = filterOf(
      unlockedResources(gs),
      (res) => Config.Resource[res].canPrice && Config.Resource[res].canStore,
   );
   forEach(getXyBuildings(gs), (xy, building) => {
      if (building.type === "Market") {
         const market = building as IMarketBuildingData;
         if (!market.availableResources) {
            market.availableResources = {};
         }
         if (sizeOf(market.availableResources) <= 0 || forceUpdatePrice) {
            const sell = shuffle(keysOf(resources), srand(priceId + xy));
            const buy = shuffle(keysOf(resources), srand(priceId + xy));
            let idx = 0;
            for (const res of sell) {
               while (buy[idx % buy.length] === res) {
                  idx++;
               }
               market.availableResources[res] = buy[idx % buy.length];
            }
         }
         if (forceUpdatePrice && hasFlag(market.marketOptions, MarketOptions.ClearAfterUpdate)) {
            market.sellResources = {};
         }
      }
   });
}

if (import.meta.env.DEV) {
   // @ts-expect-error
   window.tickGameState = (tick: number) => {
      const gs = getGameState();
      for (let i = 0; i < tick; i++) {
         tickEverySecond(gs, true);
      }
   };
}
