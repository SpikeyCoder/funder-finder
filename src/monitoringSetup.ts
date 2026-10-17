// Imported first by main.tsx, so its listeners are in place before App and
// everything it imports run: an error thrown while those modules load (a
// blank page for every visitor) is reported too.
// First: patches Array.prototype.at before web-vitals or anything else loads.
import './lib/arrayAt';
import { takeReloadMarker } from './lib/chunkReload';
import { installMonitoring } from './lib/monitoring';

takeReloadMarker();
installMonitoring();
