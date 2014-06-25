var express = require('express');
var bodyParser = require('body-parser');
var cookieParser = require('cookie-parser');
var busboy = require('connect-busboy');
var mysql = require('mysql');
var fs = require('fs-extra');
var uuid = require('node-uuid');
// var path = require('path');

// Authentication
var passport        = require('passport');
var LocalStrategy   = require('passport-local').Strategy;
var session         = require("express-session");

var publicDirectory = __dirname + "/public";
var uploadDirectory = "/uploads/";
var imageUploadDirectory = publicDirectory + uploadDirectory;

// Create uploads directory if not exists
fs.mkdirp(imageUploadDirectory, function (err) {
	if (err)
		return console.error(err);

	console.log("Directory: " + imageUploadDirectory + " created.");
});

var server = express();
server.use(busboy());
server.use(bodyParser.urlencoded());
server.use(bodyParser.json());

server.use(session({
    secret: '9bf8ea38-fb8a-11e3-8cf1-782bcbe8d576'
}));

// Initialize passport
server.use(passport.initialize()); 
// Set up the passport session
server.use(passport.session());

// Serve static files in public directory
server.use(express.static(publicDirectory));

// Create MySQL Connection Pool
var connectionPool = mysql.createPool({
	host : "localhost",
	user : "root",
	password : "root",
	database : "onlinegallery"
});

// Get user by id from db
function getUserById(id, done) {
    connectionPool.getConnection(function (err, connection) {
		if (err) {
			console.error("Connection error: ", err);
			return done(err);
		}


    	var lookupQuery = "select id, username, password from user where id=?";

		connection.query(lookupQuery, [id], function (err, result) {
			connection.release();

			if (err)
				return done(err, null);

			var userInfo = result[0];
			if (!userInfo)
				return done(null, null);

			return done(null, {id:userInfo.id, username:userInfo.username});
		});
    });
}

// This is how a user gets serialized
passport.serializeUser(function(user, done) {
    done(null, user.id);
});

// This is how a user gets deserialized
passport.deserializeUser(function(id, done) {
    // Look the user up in the database and return the user object
    return getUserById(id, function (err, user) {
    	if (err)
    		return done(err);

    	if (!user)
    		return done(null, false, {success: false, message: "No user found"});

    	return done(err, user);
    });
});

// Lookup a user in our database
var lookupUser = function(username, password, done) {
	var lookupQuery = "select id, username, password from user where username=?";
	connectionPool.getConnection(function (err, connection) {
		if (err) {
			console.error("Connection error: ", err);
			return done(err);
		}

		connection.query(lookupQuery, [username], function (err, result) {
			connection.release();

			if (err)
				return done(err);

			var userInfo = result[0];
			if (!userInfo)
				return done (null, false, {success: false, message: "No user exists"});
			else if (password === result[0]["password"])
				return done (null, {id:userInfo.id, username:userInfo.username});
			else
				return done (null, false, {success: false, message: "Wrong password"});
		});
	});
};

// Use local strategy for authenticating users
passport.use('local', new LocalStrategy(lookupUser));

// POST /signup
var signupRoute = function (req, res, next) {
	var username = req.body.username;
	var password = req.body.password;

	if (!username || !password) {
		return res.json({success: false, message:"Invalid fields"});
	}

	connectionPool.getConnection(function (err, connection) {
		if (err)
			return next(err);

		var lookupQuery = "select id, username, password from user where username = ?";
		connection.query(lookupQuery, [username], function (err, result) {
			if (err)
				return next(err);

			if (result.length > 0) {
				connection.release();
				return res.json({success: false, message: "User " + username + " already exists"});
			}
			else {
				var insertQuery = "insert into user set username = ?, password = ?";
				connection.query(insertQuery, [username, password], function (err, result) {
					connection.release();

					if (err)
						return next (err);

					return getUserById(result.insertId, function (err, user) {
						// Create user directory
						var directory = imageUploadDirectory + user.id;
						fs.mkdir(directory, null);
						return performLogin(req, res, user, next);
					});
				});
			}
		});
	});
};

// Login the user
function performLogin (req, res, user, next) {
    // Log the user in!
    req.logIn(user, function(err) {
        if (err) { 
            return next(err);
        }

        console.log(req.isAuthenticated());
        req.session.user_id = req.user.id;

        if(user.username) {
            return res.json({ success: true, message: 'Welcome ' + user.username + "!"});
        }
        
        return res.json({ success: true, message: 'Welcome!'});
    });
}

// POST /login
var loginRoute = function(req, res, next) {
	console.log("Got login request");
    // The local login strategy
    passport.authenticate('local', function (err, user) {
    	if (err) {
	        return next(err);
	    }

	    // Technically, the user should exist at this point, but if not, check
	    if(!user) {
	    	return res.json(200, {success: false, message:"Please check your details and try again."});
	    }

	    return performLogin(req, res, user, next);
    })(req, res, next);
};

// POST /photos
var postPhotosRoute = function (req, res, next) {
	req.pipe(req.busboy);
	req.busboy.on('file', function (fieldname, file, filename) {
		if (!file) {
			return res.json({success: false, message: "There was an error uploading the image"});
		}

		var imageName = filename;//uuid.v1() + path.extname(filename);
		var directory = imageUploadDirectory + req.session.user_id;

		var newPath = directory + "/" + imageName;

		var fileStream = fs.createWriteStream(newPath);
		if (!fileStream)
			return res.json({success: false, message: "Cannot create file on server. Please try again."});

		file.pipe(fileStream);
		fileStream.on('close', function () {
		    connectionPool.getConnection(function (err, connection) {
				if (err)
					return next(err);

				var insertQuery = "insert into photos set userid = ?, imagename = ?";
				connection.query(insertQuery, [req.session.user_id, imageName], function (err, result) {
					connection.release();

					if (err)
						return next(err);

					return res.json({success: true, message: "Image saved successfully: " + imageName});
				});
			});
        });
	});
}

// GET /photos
var getPhotosRoute = function (req, res, next) {
	connectionPool.getConnection(function (err, connection) {
		if (err)
			return next(err);

		var query = "select imagename from photos where userid = ?";
		connection.query(query, [req.session.user_id], function (err, result) {
			if (err)
				return next(err);

			connection.release();

			var images = [];
			for (var idx in result) {
				// Create image url based on currently logged in user
				var imageURL = req.protocol + "://" + req.get('Host') + uploadDirectory + req.session.user_id + "/" + result[idx].imagename;
				images.push(imageURL);
			};

			return res.json({success: true, message: images});
		});
	});
};

// GET /hello
// Just for testing purposes
var helloRoute =function(req, res, next) {
    if(req.user) {
        return res.send("Hello " + req.user.username);
    } else {
        return res.send("Hello unauthenticated user");
    }
};

// Ensure Authentication for request middleware
function ensureAuthenticated(req, res, next) {
	if (req.isAuthenticated()) { return next() };
	res.json(401, {succes: false, message: "Please login again", error: "Invalid request"});
};

// Routes
server.post('/signup', signupRoute);
server.post('/login', loginRoute);
server.get('/hello', helloRoute);
server.post('/photos', ensureAuthenticated, postPhotosRoute);
server.get('/photos', ensureAuthenticated, getPhotosRoute);

// Launch the server
server.listen(5000, function() {
    console.log('Server running at port 5000');
});
