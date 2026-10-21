var mongoose = require('mongoose');

module.exports = function (router) {
    router.get('/health', async function (req, res) {
        res.set('Cache-Control', 'no-store');

        try {
            if (mongoose.connection.readyState !== 1) {
                throw new Error('Database is not connected');
            }

            await mongoose.connection.db.command({ ping: 1 }, { timeoutMS: 3000 });
            res.status(200).json({
                message: 'API and database are healthy',
                data: { status: 'ok', database: 'connected' }
            });
        } catch (err) {
            res.status(503).json({
                message: 'Database is unavailable',
                data: { status: 'unavailable', database: 'unavailable' }
            });
        }
    });

    return router;
};
