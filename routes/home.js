module.exports = function (router) {

    var homeRoute = router.route('/');

    homeRoute.get(function (req, res) {
        res.json({ message: 'API is running', data: { health: '/api/health' } });
    });

    return router;
}
