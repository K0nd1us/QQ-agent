import { createRequire } from 'node:module';
console.log('node builtins', process.versions.electron, process.versions.node);
const req = createRequire(import.meta.url);
try { const e = req('electron'); console.log('req electron', typeof e, Object.keys(e).slice(0,5)); } catch (err) { console.log('req err', err.message); }
try { const e = await import('electron'); console.log('dyn import', typeof e.app, Object.keys(e).slice(0,8)); } catch (err) { console.log('dyn err', err.message); }
