var express = require('express');
var Task = require('../models/task');
var User = require('../models/user');

module.exports = function (router) {
    var tasks = express.Router();

    function parseJSONParam(param) {
        if (!param) return undefined;
        try {
            return JSON.parse(param);
        } catch (e) {
            return null;
        }
    }

    // helper to add/remove task from user pendingTasks
    function addTaskToUser(userId, taskId, userName) {
        if (!userId) return Promise.resolve();
        return User.updateOne({ _id: userId, pendingTasks: { $ne: taskId } }, { $push: { pendingTasks: taskId } }).then(function () {
            return User.updateOne({ _id: userId }, { $set: { name: userName } }).catch(function () { });
        });
    }

    function removeTaskFromUser(userId, taskId) {
        if (!userId) return Promise.resolve();
        return User.updateOne({ _id: userId }, { $pull: { pendingTasks: taskId } });
    }

    // GET /api/tasks
    tasks.get('/', function (req, res) {
        var where = parseJSONParam(req.query.where);
        var sort = parseJSONParam(req.query.sort);
        var select = parseJSONParam(req.query.select);
        var skip = req.query.skip ? parseInt(req.query.skip) : undefined;
        var limit = req.query.limit ? parseInt(req.query.limit) : 100; // default 100
        var count = req.query.count === 'true' || req.query.count === true;

        if (where === null || sort === null || select === null) {
            return res.status(400).json({ message: 'Bad Request: malformed JSON in query parameters', data: {} });
        }

        var q = Task.find(where || {});
        if (select) q = q.select(select);
        if (sort) q = q.sort(sort);
        if (!isNaN(skip)) q = q.skip(skip);
        if (!isNaN(limit)) q = q.limit(limit);

        if (count) {
            Task.countDocuments(where || {}).then(function (c) {
                return res.status(200).json({ message: 'OK', data: c });
            }).catch(function (err) {
                return res.status(500).json({ message: 'Server error', data: err });
            });
        } else {
            q.exec().then(function (docs) {
                return res.status(200).json({ message: 'OK', data: docs });
            }).catch(function (err) {
                return res.status(500).json({ message: 'Server error', data: err });
            });
        }
    });

    // POST /api/tasks
    tasks.post('/', async function (req, res) {
        try {
            var name = req.body.name;
            var deadline = req.body.deadline;
            var description = req.body.description || '';
            var completed = (req.body.completed === 'true' || req.body.completed === true);
            var assignedUser = req.body.assignedUser || '';
            var assignedUserName = req.body.assignedUserName || (assignedUser ? 'unassigned' : 'unassigned');

            if (!name || !deadline) {
                return res.status(400).json({ message: 'Bad Request: name and deadline are required', data: {} });
            }

            var dl = new Date(parseInt(deadline));
            var t = new Task({ name: name, description: description, deadline: dl, completed: completed, assignedUser: assignedUser, assignedUserName: assignedUserName });
            var saved = await t.save();

            // If assigned and not completed, add to user's pendingTasks
            if (assignedUser && !completed) {
                await User.updateOne({ _id: assignedUser }, { $addToSet: { pendingTasks: saved._id.toString() }, $set: { name: assignedUserName } }).catch(function () { });
            }

            return res.status(201).json({ message: 'Task created', data: saved });
        } catch (err) {
            return res.status(500).json({ message: 'Server error', data: err });
        }
    });

    // GET /api/tasks/:id
    tasks.get('/:id', function (req, res) {
        var select = parseJSONParam(req.query.select);
        if (select === null) return res.status(400).json({ message: 'Bad Request: malformed JSON in select', data: {} });

        var q = Task.findById(req.params.id);
        if (select) q = q.select(select);
        q.exec().then(function (task) {
            if (!task) return res.status(404).json({ message: 'Not Found', data: {} });
            return res.status(200).json({ message: 'OK', data: task });
        }).catch(function (err) {
            return res.status(500).json({ message: 'Server error', data: err });
        });
    });

    // PUT /api/tasks/:id
    tasks.put('/:id', async function (req, res) {
        try {
            var body = req.body;
            if (!body.name || !body.deadline) {
                return res.status(400).json({ message: 'Bad Request: name and deadline are required', data: {} });
            }

            var task = await Task.findById(req.params.id);
            if (!task) return res.status(404).json({ message: 'Not Found', data: {} });

            // Disallow modifying an already completed task
            if (task.completed === true) {
                return res.status(400).json({ message: 'Bad Request: cannot modify a completed task', data: {} });
            }

            var oldAssigned = task.assignedUser;
            var oldCompleted = task.completed;

            // update fields
            task.name = body.name;
            task.description = body.description || '';
            task.deadline = new Date(parseInt(body.deadline));
            task.completed = (body.completed === 'true' || body.completed === true);
            task.assignedUser = body.assignedUser || '';
            task.assignedUserName = body.assignedUserName || (task.assignedUser ? task.assignedUserName : 'unassigned');

            var saved = await task.save();

            // If assigned user changed, remove from old user's pendingTasks
            if (oldAssigned && oldAssigned.toString() !== (task.assignedUser || '').toString()) {
                await removeTaskFromUser(oldAssigned, task._id.toString());
            }

            // If now assigned and not completed, add to user's pendingTasks
            if (task.assignedUser && !task.completed) {
                await addTaskToUser(task.assignedUser, task._id.toString(), task.assignedUserName);
            }

            // If marked completed, ensure it's removed from user's pendingTasks
            if (task.completed && oldCompleted === false && task.assignedUser) {
                await removeTaskFromUser(task.assignedUser, task._id.toString());
            }

            return res.status(200).json({ message: 'Task updated', data: saved });
        } catch (err) {
            return res.status(500).json({ message: 'Server error', data: err });
        }
    });

    // DELETE /api/tasks/:id
    tasks.delete('/:id', async function (req, res) {
        try {
            var task = await Task.findById(req.params.id);
            if (!task) return res.status(404).json({ message: 'Not Found', data: {} });

            // remove from assigned user's pendingTasks
            if (task.assignedUser) {
                await removeTaskFromUser(task.assignedUser, task._id.toString());
            }

            await Task.deleteOne({ _id: req.params.id });
            return res.status(204).send();
        } catch (err) {
            return res.status(500).json({ message: 'Server error', data: err });
        }
    });

    return tasks;
};
