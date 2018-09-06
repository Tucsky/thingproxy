const http = require('http');
const https = require('https');
const url = require('url');
const resolveHostname = require('public-address');

const config = Object.assign({
	port: process.env.PORT,
}, require('./config'));

const pmx = require('pmx');
const probe = pmx.probe();

const EXPIRATION_DURATION = 1000 * 60 * 60 * 1;

let SERVERIP;
let REQUESTS = {};
let CLIENTS = {};
let METRICS = {};
let CACHE = {};

if (process.env.pmx) {
	METRICS.req_per_min = probe.meter({
		name: 'req/min',
		samples: 1,
		timeframe: 60
	});
}

if (config.enable_rate_limiting) {

	/* Cleanup expired rate limit data after 1h of inactivity
	*/

	setInterval(() => {
		const now = +new Date();

		for (client in CLIENTS) {
			if (!CLIENTS[client].count || now - client.timestamp > 1000 * 60 * 60) {
				delete CLIENTS[client];
			}
		}

		for (key in CACHE) {
			if (now > CACHE[key].expiration) {
				delete CACHE[key];
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

function getClientAddress(req) {
	return (req.headers['x-forwarded-for'] || '').split(',')[0] || req.connection.remoteAddress;
}

function doProxyRequest(req, mainResponse) {
  req.pause();

	return new Promise((resolve, reject) => {
		req.target.headers = req.headers;
		req.target.method = req.method;
		req.target.agent = false;

		// return options pre-flight requests right away
		if (req.method.toUpperCase() === 'OPTIONS') {
			return reject(writeResponse(mainResponse, 204));
		}

		// we don't support relative links
		if (!req.target.host) {
			return reject(writeResponse(mainResponse, 404, `relative URLS are not supported`));
		}

		// is origin's hostname blacklisted
		if (config.blacklist_hostname_regex.test(req.target.hostname)) {
			return reject(writeResponse(mainResponse, 400, `naughty, naughty...`));
		}

		// is req.target's hostname whitelisted
		if (!config.whitelist_hostname_regex.test(req.target.hostname)) {
			return reject(writeResponse(mainResponse, 400, `naughty, naughty...`));
		}


		// ensure that protocol is either http or https
		if (req.target.protocol != 'http:' && req.target.protocol !== 'https:') {
			return reject(writeResponse(mainResponse, 400, `only http and https are supported`));
		}

		// add an x-forwarded-for header
		if (SERVERIP) {
			if (req.target.headers['x-forwarded-for']) {
				req.target.headers['x-forwarded-for'] += ', ' + SERVERIP;
			}
			else {
				req.target.headers['x-forwarded-for'] = req.ip + ', ' + SERVERIP;
			}
		}

		// make sure the host header is to the URL we're requesting, not thingproxy
		if (req.target.headers['host']) {
			req.target.headers['host'] = req.target.host;
		}

		// make sure origin is unset just as a direct request
		delete req.target.headers['origin'];

		req.target.headers['Accept-Encoding'] = 'identity';

		var connector = (req.target.protocol == 'https:' ? https : http).request(req.target, function(targetResponse) {
			targetResponse.pause();

			let data = [];

			targetResponse.on('data', chunk => {
				data.push(chunk);
			});

			targetResponse.on('end', () => {
				if (targetResponse.statusCode !== 200) {
					return;
				}

				console.log(`cache %s until %s`, req.target.href, new Date(+new Date() + EXPIRATION_DURATION).toString());

				CACHE[req.target.href] = {
					expiration: +new Date() + EXPIRATION_DURATION,
					type: targetResponse.headers['content-type'],
					data: Buffer.concat(data)
				}
			});

			delete targetResponse.headers['set-cookie'];

			switch (targetResponse.statusCode) {
				// pass through.  we're not too smart here...
				case 200: case 201: case 202: case 203: case 204: case 205: case 206:
				case 304:
				case 400: case 401: case 402: case 403: case 404: case 405:
				case 406: case 407: case 408: case 409: case 410: case 411:
				case 412: case 413: case 414: case 415: case 416: case 417: case 418:
					mainResponse.writeHeader(targetResponse.statusCode, targetResponse.headers);
					targetResponse.pipe(mainResponse, {end:true});
					targetResponse.resume();
				break;

				// fix host and pass through.
				case 301:
				case 302:
				case 303:
					targetResponse.statusCode = 303;
					targetResponse.headers['location'] = 'http://localhost:'+ config.port +'/'+targetResponse.headers['location'];
					mainResponse.writeHeader(targetResponse.statusCode, targetResponse.headers);
					targetResponse.pipe(mainResponse, {end:true});
					targetResponse.resume();
				break;

				// error everything else
				default:
					var stringifiedHeaders = JSON.stringify(targetResponse.headers, null, 4);
					targetResponse.resume();
					mainResponse.writeHeader(500);
					mainResponse.end(process.argv.join(' ') + ':\n\nError ' + targetResponse.statusCode + '\n' + stringifiedHeaders);
				break;
			}

			resolve();
		});

		connector.on('error', (error) => {
			console.error('Error in piped request', error.message);
		});

		setTimeout(() => {
			req.pipe(connector, {end:true});
			req.resume();
		}, req.delay)
	});
}

const server = http.createServer(function(req, res) {
	addCORSHeaders(req, res);

	METRICS.req_per_min.mark();

	const now = +new Date();

	try {
		req.target = url.parse(decodeURI(req.url.replace(/^\//, '')));

		if (!req.target || !req.target.href) {
			throw `Unable to parse url`;
		}
	} catch (e) {
		return sendInvalidURLResponse(res);
	}

	if (CACHE[req.target.href] && CACHE[req.target.href].data && +new Date() < CACHE[req.target.href].expiration) {
		res.writeHead(200, {'Content-Type': CACHE[req.target.href].type || 'application/json'});
		res.end(CACHE[req.target.href].data);

		return;
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

		CLIENTS[req.ip].count++;
		REQUESTS[req.target.hostname]++;
	} else {
		req.delay = 0;
	}

	if (config.enable_logging) {
		console.log('%s %s %s with %s delay', req.ip, req.method, req.target.href, req.delay);
	}

	const decreaseRateLimitTimeout = setTimeout(() => {
		REQUESTS[req.target.hostname] && REQUESTS[req.target.hostname]--;
		CLIENTS[req.ip] && CLIENTS[req.ip].count--;
	}, 10000 + req.delay)

	try {
		doProxyRequest(req, res)
			.then(() => {})
			.catch(err => {})
			.then(() => {
				clearTimeout(decreaseRateLimitTimeout);

				setTimeout(() => {
					REQUESTS[req.target.hostname] && REQUESTS[req.target.hostname]--;
					CLIENTS[req.ip] && CLIENTS[req.ip].count--;
				}, 2000);
			})
	} catch (error) {
		console.error('Error in proxy request', error.message);
	}
}).listen(config.port);

console.log('thingproxy.freeboard.io process started (PID ' + process.pid + ')');