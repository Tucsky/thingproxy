module.exports = {
  port: process.env.PORT || 1338,
  enable_logging: true,
  max_request_length: 1000000,
  enable_rate_limiting: true,

  // a timeout is applied to each hostname / ip specific request
  increment_timeout_by: 1000,

  // if there is 15+ simultaneous request from 1 ip the error 429 is returned
  max_simultaneous_requests_per_ip: 15,
  whitelist_hostname_regex: new RegExp(
    `^(${[
      'api.kraken.com',
      'api.binance.com',
      'api.bitfinex.com',
      'api.gdax.com',
      'api.pro.coinbase.com',
      'api.prime.coinbase.com',
      'www.bitstamp.net',
      'api.hitbtc.com',
      'www.poloniex.com',
      'www.okex.com',
      'api.huobi.pro',
      'www.bitmex.com',
      'www.deribit.com',
      'fapi.binance.com',
      'dapi.binance.com',
      'api.hbdm.com',
      'ftx.com',
      'futures.kraken.com',
      'api.bybit.com'
    ].join('|')})$`
  ),
  blacklist_hostname_regex: /^(10\.|192\.|127\.|localhost$)/i // Good for limiting access to internal IP addresses and hosts.
}
