var mongoose = require('mongoose');

var UserSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true, cast: false },
    email: { type: String, required: true, trim: true, cast: false, unique: true },
    pendingTasks: {
        type: [{ type: String, cast: false }],
        default: [],
        castNonArrays: false
    },
    dateCreated: { type: Date, default: Date.now, immutable: true }
});

// Ignore client-provided creation dates.
UserSchema.pre('validate', function () {
    if (this.isNew) this.dateCreated = new Date();
});

module.exports = mongoose.model('User', UserSchema);
