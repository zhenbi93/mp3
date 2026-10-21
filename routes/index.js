module.exports = function (app, router) {
    require('./health.js')(router);
    require('./users.js')(router);
    require('./tasks.js')(router);
    app.use('/api', require('./home.js')(router));
    app.use(function (req, res) {
        res.status(404).json({ message: 'Endpoint not found', data: null });
    });
    app.use(require('../lib/api').errors);
};
