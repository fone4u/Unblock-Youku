/*
 * Allow you smoothly surf on many websites blocking non-mainland visitors.
 * Copyright (C) 2012, 2013 Bo Zhu http://zhuzhu.org
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */


var url = require('url');
var util = require('util');
var http = require('http');
var querystring = require('querystring');

var regex_url_list = require('../shared/urls').regex_url_list;
var new_sogou_proxy_addr = require('../shared/sogou').new_sogou_proxy_addr;
var shared_tools = require('../shared/tools');
var string_starts_with = shared_tools.string_starts_with;
var to_title_case = shared_tools.to_title_case;


function get_first_external_ip() {
    try {
        // only return the first external ip, which should be fine for usual cases
        var interfaces = require('os').networkInterfaces();
        var i, j;
        for (i in interfaces) {
            if (interfaces.hasOwnProperty(i)) {
                for (j = 0; j < interfaces[i].length; j++) {
                    var addr = interfaces[i][j];
                    if (addr.family === 'IPv4' && !addr.internal) {
                        return addr.address;
                    }
                }
            }
        }
    } catch (err) {
        return '127.0.0.1';
    }

    return '127.0.0.1';  // no external ip, so bind internal ip
}


function get_real_target(req_path) {
    var real_target = {};

    // the 'path' in proxy requests should always start with http
    if (string_starts_with(req_path, 'http')) {
        real_target = url.parse(req_path);
    } else {
        var real_url = querystring.parse(url.parse(req_path).query).url;
        if (real_url) {
            var buf = new Buffer(real_url, 'base64');
            real_url = buf.toString();
            real_target = url.parse(real_url);
        }
    }
    if (!real_target.port) {
        real_target.port = 80;
    }
    return real_target;
}


function is_valid_url(target_url) {
    var i;
    for (i = 0; i < regex_url_list.length; i++) {
        if (regex_url_list[i].test(target_url)) {
            return true;
        }
    }
    if ('http://httpbin.org' === target_url.slice(0, 18)) {
        return true;
    }

    return false;
}


function renew_sogou_server(callback, depth) {
    var new_addr = new_sogou_proxy_addr();
    // new_addr = 'h8.dxt.bj.ie.sogou.com';

    if (typeof depth === 'undefined') {
        depth = 0;
    } else if (depth >= 10) {
    // } else if (depth >= 3) {
        callback(new_addr);
        return;
    }

    // console.log(new_addr + ' depth ' + depth);
    
    var options = {
        host: new_addr,
        headers: {
            "Accept-Language": "en-US,en;q=0.8,zh-CN;q=0.6,zh;q=0.4,zh-TW;q=0.2",
            "Accept-Encoding": "deflate",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_8_2) AppleWebKit/537.11 (KHTML, like Gecko) Chrome/23.0.1271.95 Safari/537.11",
            "Accept-Charset": "gb18030,utf-8;q=0.7,*;q=0.3"
        }
    };

    var req = http.request(options, function(res) {
        if (400 === res.statusCode) {
            callback(new_addr);
        } else {
            util.error('[ub.uku.js] statusCode for ' + new_addr + ' is unexpected: ' + res.statusCode);
            renew_sogou_server(callback, depth + 1);
        }
    });

    // http://goo.gl/G2CoU
    req.on('socket', function(socket) {
        socket.setTimeout(10 * 1000, function() {  // 10s
            req.abort();
            util.error('[ub.uku.js] Timeout for ' + new_addr + '. Aborted.');
        });
    });

    req.on('error', function(err) {
        util.error('[ub.uku.js] Error when testing ' + new_addr + ': ' + err);
        renew_sogou_server(callback, depth + 1);
    });

    req.end();
}


function filtered_request_headers(headers, forward_cookie) {
    var ret_headers = {};

    var field;
    for (field in headers) {
        if (headers.hasOwnProperty(field)) {
            if (string_starts_with(field, 'proxy-')) {
                if (field === 'proxy-connection') {
                    ret_headers.Connection = headers['proxy-connection'];
                }
            } else if (field === 'cookie') {
                if (forward_cookie) {
                    ret_headers.Cookie = headers.cookie;
                }
            } else if (field === 'user-agent') {
                if (headers['user-agent'].indexOf('CloudFront') !== -1 ||
                        headers['user-agent'].indexOf('CloudFlare') !== -1) {
                    ret_headers['User-Agent'] = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_8_3) ' + 
                        'AppleWebKit/537.31 (KHTML, like Gecko) Chrome/26.0.1410.65 Safari/537.31';
                } else {
                    ret_headers['User-Agent'] = headers['user-agent'];
                }
            } else if (field !== 'via' && (!string_starts_with(field, 'x-'))) {
                // in case some servers do not recognize lower-case headers, such as hacker news
                ret_headers[to_title_case(field)] = headers[field];
            }
        }
    }

    return ret_headers;
}

function filtered_response_headers(headers, forward_cookie) {
    var res_headers = {};

    var field;
    for (field in headers) {
        if (headers.hasOwnProperty(field)) {
            if (string_starts_with(field, 'proxy-')) {
                if (field === 'proxy-connection') {
                    res_headers.connection = headers['proxy-connection'];
                }
            } else if (field === 'set-cookie') {
                // cannot set cookies for another domain in redirect mode
                if (forward_cookie) {
                    res_headers['set-cookie'] = headers['set-cookie'];
                }
            } else if (field !== 'cache-control' && field !== 'expires' &&  // to improve caching
                    field !== 'pragma' && field !== 'age' && field !== 'via' &&
                    (!string_starts_with(field, 'x-'))) {
                res_headers[field] = headers[field];
            }
        }
    }
    res_headers['cache-control'] = 'public, max-age=3600';

    return res_headers;
}


exports.get_first_external_ip = get_first_external_ip;
exports.get_real_target = get_real_target;
exports.is_valid_url = is_valid_url;
exports.renew_sogou_server = renew_sogou_server;
exports.filtered_request_headers = filtered_request_headers;
exports.filtered_response_headers = filtered_response_headers;

