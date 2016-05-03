var	_ = require('lodash'),
	Queue = require('bull'),
	config = require('./config'),
	Promise = require('bluebird'),
	request = require('superagent'),
	dns = Promise.promisifyAll(require('dns')),
	fs = Promise.promisifyAll(require('fs'));

var resolv = fs.readFileSync('/etc/resolv.conf', {encoding: 'utf-8'});
if (resolv.indexOf('127.0.0.1') === -1) {
	fs.writeFileSync('/etc/resolv.conf', 'nameserver 127.0.0.1')
	// Exception throw is expected here
}

var MTA = require('dermail-smtp-inbound');
var messageQ = new Queue('dermail-mta', config.redisQ.port, config.redisQ.host);

var validateRecipient = function(email, envelope) {
	return new Promise(function(resolve, reject) {
		return request
		.post(config.rx.checkRecipient())
		.timeout(5000)
		.send({
			to: email,
			remoteSecret: config.remoteSecret
		})
		.set('Accept', 'application/json')
		.end(function(err, res){
			if (err) {
				// Service not available, we will let it slide
				return resolve();
			}
			if (res.body.ok === true) {
				return resolve();
			}else{
				return reject(new Error('Invalid'));
			}
		});
	})
}

var mailReady = function(connection) {
	return new Promise(function(resolve, reject) {
		return messageQ.add({
			type: 'processMail',
			payload: connection
		}, config.Qconfig)
		.then(function() {
			return resolve();
		})
	})
}

var reverseIP = function(ip) {
	var array = ip.split('.');
	array.reverse();
	return array.join('.');
}

var spamhausReturnCodes = {
	'127.0.0.2': 'SBL - Spamhaus Maintained',
	'127.0.0.3': '- - reserved for future use',
	'127.0.0.4': 'XBL - CBL Detected Address',
	'127.0.0.5': 'XBL - NJABL Proxies (customized)',
	'127.0.0.6': 'XBL - reserved for future use',
	'127.0.0.7': 'XBL - reserved for future use',
	'127.0.0.8': 'XBL - reserved for future use',
	'127.0.0.9': '- - reserved for future use',
	'127.0.0.10': 'PBL - ISP Maintained',
	'127.0.0.11': 'PBL - Spamhaus Maintained',
} // http://zee.balogh.sk/?p=881

var spamhausZen = function(ip) {
	return new Promise(function(resolve, reject) {
		ip = reverseIP(ip);
		var query = ip + '.zen.spamhaus.org';
		return dns
		.resolve4Async(query)
		.then(resolve)
		.catch(reject);
	})
}

var validateConnection = function(connection) {
	return new Promise(function(resolve, reject) {
		var remoteAddress = connection.remoteAddress;
		return spamhausZen(remoteAddress)
		.then(function(rejection) {
			console.log(connection, rejection)
			return reject(new Error('Your IP is Blacklisted by Spamhaus'))
		})
		.catch(function(acceptance) {
			return resolve();
		})
	})
}

MTA.start({
	doNotParse: true,
	port: process.env.PORT || 25,
	handlers: {
		validateConnection: validateConnection,
		validateRecipient: validateRecipient,
		mailReady: mailReady
	},
	smtpOptions: {
		size: 26214400, // 50 MB message limit
		banner: 'Dermail.net, by sdapi.net',
		key: fs.readFileSync(__dirname + '/ssl/key'),
		cert: fs.readFileSync(__dirname + '/ssl/chain')
	}
});

console.log('Process ' + process.pid + ' is listening to incoming SMTP.')