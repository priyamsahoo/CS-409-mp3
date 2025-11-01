/*
 * Connect all of your endpoints together here.
 */
module.exports = function (app, router) {
    var apiRouter = require('./home.js')(router);
    // mount users and tasks routes onto /api
    apiRouter.use('/users', require('./users')(router));
    apiRouter.use('/tasks', require('./tasks')(router));
    app.use('/api', apiRouter);
};
