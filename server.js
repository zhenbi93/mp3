const mongoose = require('mongoose');
require('dotenv').config();
const app = require('./app');

const port = process.env.PORT || 3000;
mongoose.connect(process.env.MONGODB_URI).catch(function (err) {
    console.error('MongoDB connection error:', err.message);
});

app.listen(port);
console.log('Server running on port ' + port);
