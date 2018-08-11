const http = require('http');
const url = require('url');
const request = require('request');
const resolveHostname = require('public-address');

const config = Object.assign({
	port: process.env.PORT,
}, require('./config'));

const pmx = require('pmx');
const probe = pmx.probe();

let SERVERIP;
let REQUESTS = {};
let CLIENTS = {};
let METRICS = {};

if (process.env.pmx) {
	METRICS.stored_clients = probe.metric({
		name: 'Stored clients',
		agg_type: 'max',
		value: () => {
			return Object.keys(CLIENTS).length;
		}
	});

	METRICS.average_delay = probe.histogram({
		name: 'latency',
		measurement: 'mean'
	});
}

if (config.enable_rate_limiting) {

	/* Cleanup expired rate limit data after 1h of inactivity
	*/

	setInterval(() => { 
		const now = +new Date();

		for (client in CLIENTS) {
			if (!client.count || now - client.timestamp > 1000 * 60 * 60) {
				delete CLIENTS[client];
			}
		}
	}, 1000 * 60);
}

resolveHostname(function (err, data) {
	if (!err && data) {
		SERVERIP = data.address;
	}
});

function addCORSHeaders(req, res) {
	if (req.method.toUpperCase() === 'OPTIONS') {
		if (req.headers['access-control-request-headers']) {
			res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers']);
		}

		if (req.headers['access-control-request-method']) {
			res.setHeader('Access-Control-Allow-Methods', req.headers['access-control-request-method']);
		}
	}

	if (req.headers['origin']) {
		res.setHeader('Access-Control-Allow-Origin', req.headers['origin']);
	}
	else {
		res.setHeader('Access-Control-Allow-Origin', '*');
	}
}

function writeResponse(res, httpCode, body) {
	res.statusCode = httpCode;
	res.end(body);
}

function sendInvalidURLResponse(res) {
	return writeResponse(res, 404);
}

function sendTooBigResponse(res) {
	return writeResponse(res, 413, `the content in the request or response cannot exceed ${config.max_request_length} characters.`);
}

function getClientAddress(req) {
	return (req.headers['x-forwarded-for'] || '').split(',')[0] || req.connection.remoteAddress;
}

function processRequest(req, res) {
	return new Promise((resolve, reject) => {
		setTimeout(() => {
			addCORSHeaders(req, res);

			// return options pre-flight requests right away
			if (req.method.toUpperCase() === 'OPTIONS') {
				return reject(writeResponse(res, 204));
			}

			// we don't support relative links
			if (!req.target.host) {
				return reject(writeResponse(res, 404, `relative URLS are not supported`));
			}

			// is origin's hostname blacklisted
			if (config.blacklist_hostname_regex.test(req.target.hostname)) {
				return reject(writeResponse(res, 400, `naughty, naughty...`));
			}

			// is req.target's hostname whitelisted 
			if (!config.whitelist_hostname_regex.test(req.target.hostname)) {
				return reject(writeResponse(res, 400, `naughty, naughty...`));
			}


			// ensure that protocol is either http or https
			if (req.target.protocol != 'http:' && req.target.protocol !== 'https:') {
				return reject(writeResponse(res, 400, `only http and https are supported`));
			}

			// add an x-forwarded-for header
			if (SERVERIP) {
				if (req.headers['x-forwarded-for']) {
					req.headers['x-forwarded-for'] += ', ' + SERVERIP;
				}
				else {
					req.headers['x-forwarded-for'] = req.ip + ', ' + SERVERIP;
				}
			}

			// make sure the host header is to the URL we're requesting, not thingproxy
			if (req.headers['host']) {
				req.headers['host'] = req.target.host;
			}

			// make sure origin is unset just as a direct request
			delete req.headers['origin'];

			// create the actual proxy request
			var proxyRequest = request({
				url: req.target,
				method: req.method,
				headers: req.headers,
				timeout: config.proxy_request_timeout_ms,
			}, () => {
				resolve();
			});

			// head result error
			proxyRequest.on('error', function (err) {
				if (err.code === 'ENOTFOUND') {
					return reject(writeResponse(res, 502, `Host for ${req.target.href} cannot be found.`))
				} else {
					console.error(`Proxy Request Error (${req.target.href}): ${err.toString()}`);
					return reject(writeResponse(res, 500));
				}
			});

			let contentLength = 0;
			let proxyContentLength = 0;

			req.pipe(proxyRequest).on('data', function (data) {
				contentLength += data.length;

				if (contentLength >= config.max_request_length) {
					proxyRequest.end();
					return reject(sendTooBigResponse(res))
				}
			}).on('error', function (err) {
				reject(writeResponse(res, 500, 'Stream Error'));
			});

			proxyRequest.pipe(res).on('data', function (data) {

				proxyContentLength += data.length;

				if (proxyContentLength >= config.max_request_length) {
					proxyRequest.end();
					return reject(sendTooBigResponse(res));
				}

				console.log('data, ' + contentLength);
			}).on('error', function (err) {
				reject(writeResponse(res, 500, 'Stream Error'));
			});
		}, req.delay);
	});
}

const server = http.createServer(function(req, res) {
	const now = +new Date();

	try {
		req.target = url.parse(decodeURI(req.url.replace(/^\//, '')));

		if (!req.target || !req.target.href) {
			throw `Unable to parse url`;
		}
	} catch (e) {
		return sendInvalidURLResponse(res);
	}

	req.ip = getClientAddress(req);
	
	if (config.enable_rate_limiting) {
		if (!CLIENTS[req.ip]) {
			CLIENTS[req.ip] = {
				timestamp: now,
				count: 0,
			}
		}

		if (!REQUESTS[req.target.hostname]) {
			REQUESTS[req.target.hostname] = 0;
		}

		if (CLIENTS[req.ip].count >= config.max_simultaneous_requests_per_ip) {
			if (config.enable_logging) {
				console.log('%s got timeout', req.ip);
			}

			return writeResponse(res, 429, `enhance your calm`);
		}

		req.delay = REQUESTS[req.target.hostname] * config.increment_timeout_by + CLIENTS[req.ip].count * config.increment_timeout_by;
	
		CLIENTS[req.ip]++;

		REQUESTS[req.target.hostname]++;
	} else {
		req.delay = 0;
	}

	if (METRICS.average_delay) {
		METRICS.average_delay.update(req.delay);
	}
	
	if (config.enable_logging) {
		console.log('%s %s %s with %s delay', req.ip, req.method, req.target.href, req.delay);
	}

	const timeout = setTimeout(() => {
		REQUESTS[req.target.hostname]--;
		CLIENTS[req.ip].count--;
	}, 10000 + req.delay)

	processRequest(req, res)
		.then()
		.catch(err => {})
		.then(() => {
			clearTimeout(timeout);

			setTimeout(() => {
				REQUESTS[req.target.hostname]--;
				CLIENTS[req.ip].count--;
			}, 2000);
		})
}).listen(config.port);

console.log('thingproxy.freeboard.io process started (PID ' + process.pid + ')');