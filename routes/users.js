var express = require('express');
var mongoose = require('mongoose');
var User = require('../models/user');
var Task = require('../models/task');

module.exports = function (router) {
    var users = express.Router();

    // helper to parse JSON query params safely
    function parseJSONParam(param) {
        if (!param) return undefined;
        try {
            return JSON.parse(param);
        } catch (e) {
            return null; // signal parse error
        }
    }

    // GET /api/users
    users.get('/', function (req, res) {
        // support both 'where' and legacy 'filter' (used by db scripts) for select
        var where = parseJSONParam(req.query.where);
        var sort = parseJSONParam(req.query.sort);
        var select = parseJSONParam(req.query.select) || parseJSONParam(req.query.filter);
        var skip = req.query.skip ? parseInt(req.query.skip) : undefined;
        var limit = req.query.limit ? parseInt(req.query.limit) : undefined; // users default unlimited
        var count = req.query.count === 'true' || req.query.count === true;

        if (where === null || sort === null || select === null) {
            return res.status(400).json({ message: 'Bad Request: malformed JSON in query parameters', data: {} });
        }

        var q = User.find(where || {});
        if (select) q = q.select(select);
        if (sort) q = q.sort(sort);
        if (!isNaN(skip)) q = q.skip(skip);
        if (!isNaN(limit)) q = q.limit(limit);

        if (count) {
            User.countDocuments(where || {}).then(function (c) {
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

    // POST /api/users
    users.post('/', async function (req, res) {
        try {
            var name = req.body.name;
            var email = req.body.email;
            var pendingTasks = req.body.pendingTasks || [];

            if (!name || !email) {
                return res.status(400).json({ message: 'Bad Request: name and email are required', data: {} });
            }

            // check duplicate email
            var existing = await User.findOne({ email: email });
            if (existing) {
                return res.status(400).json({ message: 'Bad Request: email already exists', data: {} });
            }

            // If pendingTasks provided, ensure none of the tasks are already completed
            if (Array.isArray(pendingTasks) && pendingTasks.length > 0) {
                try {
                    var tasksFound = await Task.find({ _id: { $in: pendingTasks } }).select('_id completed');
                } catch (e) {
                    return res.status(400).json({ message: 'Bad Request: invalid task id in pendingTasks', data: e });
                }
                var completedIds = tasksFound.filter(function (t) { return t.completed === true; }).map(function (t) { return t._id; });
                if (completedIds.length > 0) {
                    return res.status(400).json({ message: 'Bad Request: cannot add completed tasks to pendingTasks', data: completedIds });
                }
            }

            var u = new User({ name: name, email: email, pendingTasks: pendingTasks });
            var saved = await u.save();

            // if pendingTasks provided, ensure tasks reference this user
            if (Array.isArray(pendingTasks) && pendingTasks.length > 0) {
                Task.updateMany({ _id: { $in: pendingTasks } }, { assignedUser: saved._id.toString(), assignedUserName: saved.name }).catch(function () { });
            }

            return res.status(201).json({ message: 'User created', data: saved });
        } catch (err) {
            return res.status(500).json({ message: 'Server error', data: err });
        }
    });

    // GET /api/users/:id
    users.get('/:id', function (req, res) {
        var select = parseJSONParam(req.query.select) || parseJSONParam(req.query.filter);
        if (select === null) return res.status(400).json({ message: 'Bad Request: malformed JSON in select', data: {} });

        var q = User.findById(req.params.id);
        if (select) q = q.select(select);
        q.exec().then(function (user) {
            if (!user) return res.status(404).json({ message: 'Not Found', data: {} });
            return res.status(200).json({ message: 'OK', data: user });
        }).catch(function (err) {
            return res.status(500).json({ message: 'Server error', data: err });
        });
    });

    // PUT /api/users/:id - replace entire user
    users.put('/:id', async function (req, res) {
        try {
            var body = req.body;
            if (!body.name || !body.email) {
                return res.status(400).json({ message: 'Bad Request: name and email are required', data: {} });
            }

            // validate user id format
            if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
                return res.status(400).json({ message: 'Bad Request: invalid user id format', data: {} });
            }

            // ensure email uniqueness (exclude this user)
            var other = await User.findOne({ email: body.email, _id: { $ne: req.params.id } });
            if (other) return res.status(400).json({ message: 'Bad Request: email already exists', data: {} });

            var user = await User.findById(req.params.id);
            if (!user) return res.status(404).json({ message: 'Not Found', data: {} });

            // If pendingTasks provided, we need to update tasks to point to this user
            var newPending = Array.isArray(body.pendingTasks) ? body.pendingTasks : [];

            // First, clear existing pendingTasks' assignedUser for tasks that are no longer pending
            var toRemove = user.pendingTasks.filter(function (t) { return newPending.indexOf(t) === -1; });
            if (toRemove.length > 0) {
                await Task.updateMany({ _id: { $in: toRemove } }, { assignedUser: '', assignedUserName: 'unassigned' });
            }

            // Then, set assignedUser for newly added tasks
            var toAdd = newPending.filter(function (t) { return user.pendingTasks.indexOf(t) === -1; });
            if (toAdd.length > 0) {
                // validate each id format first
                for (var i = 0; i < toAdd.length; i++) {
                    if (!mongoose.Types.ObjectId.isValid(toAdd[i])) {
                        return res.status(400).json({ message: 'Bad Request: invalid task id format in pendingTasks', data: toAdd[i] });
                    }
                }

                // ensure all tasks exist
                try {
                    var tasksFound = await Task.find({ _id: { $in: toAdd } }).select('_id completed');
                } catch (e) {
                    return res.status(400).json({ message: 'Bad Request: invalid task id in pendingTasks', data: e });
                }
                if (tasksFound.length !== toAdd.length) {
                    // compute missing ids
                    var foundIds = tasksFound.map(function (t) { return t._id.toString(); });
                    var missing = toAdd.filter(function (x) { return foundIds.indexOf(x.toString()) === -1; });
                    return res.status(404).json({ message: 'Not Found: some task ids do not exist', data: missing });
                }

                // ensure none of the tasks being added are already completed
                var completedIds = tasksFound.filter(function (t) { return t.completed === true; }).map(function (t) { return t._id; });
                if (completedIds.length > 0) {
                    return res.status(400).json({ message: 'Bad Request: cannot add completed tasks to pendingTasks', data: completedIds });
                }

                // Remove these task ids from any other user's pendingTasks to avoid stale references
                await User.updateMany({ _id: { $ne: req.params.id }, pendingTasks: { $in: toAdd } }, { $pull: { pendingTasks: { $in: toAdd } } });

                // assign tasks to this user
                if (toAdd.length > 0) {
                    await Task.updateMany({ _id: { $in: toAdd } }, { assignedUser: req.params.id, assignedUserName: body.name });
                }
            }

            // Replace fields
            user.name = body.name;
            user.email = body.email;
            user.pendingTasks = newPending;
            // ignore any dateCreated provided by client to preserve server-side creation date

            var saved = await user.save();
            return res.status(200).json({ message: 'User updated', data: saved });
        } catch (err) {
            return res.status(500).json({ message: 'Server error', data: err });
        }
    });

    // DELETE /api/users/:id
    users.delete('/:id', async function (req, res) {
        try {
            var user = await User.findById(req.params.id);
            if (!user) return res.status(404).json({ message: 'Not Found', data: {} });

            // Unassign all pending tasks
            if (user.pendingTasks && user.pendingTasks.length > 0) {
                await Task.updateMany({ _id: { $in: user.pendingTasks } }, { assignedUser: '', assignedUserName: 'unassigned' });
            }

            await User.deleteOne({ _id: req.params.id });
            // 204 No Content
            return res.status(204).send();
        } catch (err) {
            return res.status(500).json({ message: 'Server error', data: err });
        }
    });

    return users;
};
