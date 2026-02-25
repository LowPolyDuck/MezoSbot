import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";
import * as link from "./link.js";
import * as deposit from "./deposit.js";
import * as balance from "./balance.js";
import * as withdraw from "./withdraw.js";
import * as tip from "./tip.js";
import * as distribute from "./distribute.js";
import * as drop from "./drop.js";
import * as claim from "./claim.js";
import * as leaderboard from "./leaderboard.js";
import * as rain from "./rain.js";
import * as history from "./history.js";
import * as treasury from "./treasury.js";
import * as backfill from "./backfill.js";
import * as credit from "./credit.js";
import * as sweep from "./sweep.js";
import * as farm from "./farm.js";
import * as harvest from "./harvest.js";
import * as seeds from "./seeds.js";
import * as expand from "./expand.js";
import * as seeddrop from "./seeddrop.js";
import * as farmfund from "./farmfund.js";
import * as shop from "./shop.js";
import * as shopcreate from "./shopcreate.js";
import * as shopdrop from "./shopdrop.js";
import * as shopmine from "./shopmine.js";
import * as shopclaim from "./shopclaim.js";
import { gameboyCommands } from "./gameboy.js";

const baseCommands = [
  link,
  deposit,
  balance,
  withdraw,
  tip,
  distribute,
  drop,
  claim,
  leaderboard,
  rain,
  history,
  treasury,
  backfill,
  credit,
  sweep,
  farm,
  harvest,
  seeds,
  expand,
  seeddrop,
  farmfund,
  shop,
  shopcreate,
  shopdrop,
  shopmine,
  shopclaim,
];

// Merge base commands + gameboy button commands into a single list
export const commands = [
  ...baseCommands,
  ...gameboyCommands,
];

export const commandsData: RESTPostAPIChatInputApplicationCommandsJSONBody[] = commands.map(
  (c) => c.data as RESTPostAPIChatInputApplicationCommandsJSONBody
);
