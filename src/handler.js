'use strict';

const web = require('./web.js');
const worker = require('./worker.js');

module.exports.api = (event) => web.handler(event);
module.exports.worker = (event) => worker.handler(event);
