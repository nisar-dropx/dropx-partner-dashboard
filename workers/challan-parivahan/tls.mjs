// TLS trust for the Parivahan portal.
//
// The portal serves a Let's Encrypt chain whose root ("ISRG Root YE") is newer than
// Node's bundled CA list and is NOT sent by the server. That root is cross-signed by
// the universally-trusted "ISRG Root X2", so bundling it lets Node bridge the chain
// WITHOUT ever disabling certificate verification.
//
// We expose the bundled PEM's path so the entrypoint can set NODE_EXTRA_CA_CERTS to it
// before Node starts (the only reliable, dependency-free way to add a root to global
// fetch/TLS). `portalAgent` stays undefined; callers pass it through as `dispatcher`,
// which fetch simply ignores when undefined.
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the bundled cross-signed ISRG Root YE PEM. */
export const bundledCaPath = path.join(__dirname, "isrg-root-ye.pem");

/** Passed as fetch({ dispatcher }); undefined is ignored, so global TLS (with the
 *  NODE_EXTRA_CA_CERTS root) is used. Kept for call-site compatibility. */
export const portalAgent = undefined;
