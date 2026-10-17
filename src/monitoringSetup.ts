// Imported first by main.tsx, so its listeners are in place before App and
// everything it imports run: an error thrown while those modules load (a
// blank page for every visitor) is reported too.
import { installArrayAt } from './lib/arrayAt';
import { takeReloadMarker } from './lib/chunkReload';
import { installMonitoring } from './lib/monitoring';

installArrayAt(); // before installMonitoring starts web-vitals
takeReloadMarker();
installMonitoring();
