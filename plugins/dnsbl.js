// dnsbl plugin
var net_utils = require('./net_utils');

exports.register = function() {
    var plugin = this;
    plugin.inherits('dns_list_base');

    plugin.refresh_config();

    if (plugin.cfg.main.periodic_checks) {
        plugin.check_zones(plugin.cfg.main.periodic_checks);
    }

    if (plugin.cfg.main.search === 'all') {
        plugin.register_hook('connect',  'connect_multi');
    }
    else {
        plugin.register_hook('connect',  'connect_first');
    }
};

exports.refresh_config = function () {
    var plugin = this;

    var load_cfg = function () {
        plugin.cfg = plugin.config.get('dnsbl.ini', {
            booleans: ['+main.reject', '-main.enable_stats'],
        }, load_cfg);

        if (plugin.cfg.main.enable_stats && !plugin.enable_stats) {
            plugin.loginfo('stats reporting enabled');
            plugin.enable_stats = true;
        }
        if (!plugin.cfg.main.enable_stats && plugin.enable_stats) {
            plugin.loginfo('stats reporting disabled');
            plugin.enable_stats = false;
        }

        if (plugin.cfg.main.stats_redis_host && plugin.cfg.main.stats_redis_host !== plugin.redis_host) {
            plugin.redis_host = plugin.cfg.main.stats_redis_host;
            plugin.loginfo('set stats redis host to: ' + plugin.redis_host);
        }

        plugin.get_uniq_zones();
    };
    load_cfg();
};

exports.get_uniq_zones = function () {
    var plugin = this;
    plugin.zones = [];

    var unique_zones = {};

    // Compatibility with old plugin
    var legacy_zones = plugin.config.get('dnsbl.zones', 'list');
    for (var i=0; i < legacy_zones.length; i++) {
        unique_zones[legacy_zones[i]] = true;
    }

    if (plugin.cfg.main.zones) {
        var new_zones = plugin.cfg.main.zones.split(/[\s,;]+/);
        for (var h=0; h < new_zones.length; h++) {
            unique_zones[new_zones[h]] = true;
        }
    }

    for (var key in unique_zones) { plugin.zones.push(key); }
    return plugin.zones;
};

exports.should_skip = function (connection) {
    var plugin = this;

    if (!connection) { return true; }
    var rip = connection.remote_ip;

    if (net_utils.is_rfc1918(rip)) {
         connection.logdebug(plugin, 'skipping private IP: ' + rip);
         return true;
    }

    if (!plugin.zones || !plugin.zones.length) {
        connection.logerror(plugin, "no zones");
        return true;
    }

    return false;
};

exports.connect_first = function(next, connection) {
    var plugin = this;
    var remote_ip = connection.remote_ip;

    if (plugin.should_skip(connection)) { return next(); }

    plugin.first(remote_ip, plugin.zones, function (err, zone, a) {
        if (err) {
            connection.logerror(plugin, err);
            return next();
        }
        if (!a) return next();

        var msg = 'host [' + remote_ip + '] is blacklisted by ' + zone;
        if (plugin.cfg.main.reject) return next(DENY, msg);

        connection.loginfo(plugin, msg);
        return next();
    });
};

exports.connect_multi = function(next, connection) {
    var plugin = this;
    var remote_ip = connection.remote_ip;

    if (plugin.should_skip(connection)) { return next(); }

    var hits = [];
    plugin.multi(remote_ip, plugin.zones, function (err, zone, a, pending) {
        var deny_msg = 'host [' + remote_ip + '] is blacklisted by ' + hits.join(', ');
        if (err) {
            connection.results.add(plugin, {err: err});
            if (pending > 0) return;
            if (plugin.cfg.main.reject && hits.length) {
                return next(DENY, deny_msg);
            }
            return next();
        }

        if (a) {
            hits.push(zone);
            deny_msg = 'host [' + remote_ip + '] is blacklisted by ' + hits.join(', ');
            connection.results.add(plugin, {fail: zone});
        }
        else {
            connection.results.add(plugin, {pass: zone});
        }

        if (pending > 0) return;
        connection.results.add(plugin, {emit: true});

        if (plugin.cfg.main.reject && hits.length) {
            return next(DENY, deny_msg);
        }
        return next();
    });
};
