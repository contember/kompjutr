// Most tests spawn git with `...process.env`; this reaches all of them.
import { NO_AUTO_MAINTENANCE } from "./git.js";

Object.assign(process.env, NO_AUTO_MAINTENANCE);
