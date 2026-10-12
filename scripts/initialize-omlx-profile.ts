/** One-time editable model initialization; run after creating the DSH profile, while that profile is stopped. */
import { resolve } from 'node:path';
import { initializeOmlxProfile, omlxProfileOptions } from '../src/host/profile-models.ts';
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--profile-dir' || !args[1]) throw new Error('Usage: node --import tsx scripts/initialize-omlx-profile.ts --profile-dir <DSH_HOME/profiles/name>');
console.log(JSON.stringify(initializeOmlxProfile(resolve(args[1]), omlxProfileOptions(process.env))));
