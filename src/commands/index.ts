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

export const commands = [
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
] as const;

export const commandsData: RESTPostAPIChatInputApplicationCommandsJSONBody[] = commands.map(
  (c) => c.data as RESTPostAPIChatInputApplicationCommandsJSONBody
);
