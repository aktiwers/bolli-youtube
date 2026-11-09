// webOS TV 2.x's old engine: the parse worker (parse.js) with promise.js before it, as the engine's own Promise is an
// early one (api/off-thread.ts starts this worker only there)
importScripts('promise.js', 'parse.js');
