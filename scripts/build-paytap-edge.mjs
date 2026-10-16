import {readFileSync,writeFileSync} from 'node:fs';
const parser=readFileSync('src/lib/fleet/paytap.ts','utf8');
const handler=readFileSync('scripts/paytap-edge-handler.txt','utf8');
writeFileSync('supabase/functions/paytap-fuel/index.ts',`// @ts-nocheck\n// Generated from src/lib/fleet/paytap.ts and scripts/paytap-edge-handler.txt.\nimport {Buffer} from 'node:buffer';\nimport {createHash} from 'node:crypto';\n${parser}\n${handler}`);
