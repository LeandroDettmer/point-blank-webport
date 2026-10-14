// Helpers that live in the external pb-extract-tools repo (readGLB, posedMesh, packTextures...). Loaded by path,
// so this repo does not copy them. PB_TOOLS overrides the checkout; default is the sibling folder ../pb-extract-tools.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TOOLS = path.resolve(process.env.PB_TOOLS ?? path.join(HERE, '../../../../pb-extract-tools'));
export const tool = (rel) => import(pathToFileURL(path.join(TOOLS, rel)).href);
