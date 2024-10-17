const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
// const fetch = require('node-fetch');
const fetch = (...args) => import("node-fetch").then(module => module.default(...args));
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { shuffle, log, compareVersion, limitStringMaxLength, secondsToTimeDict, sleep } = require('./functions');

// Read config from the config.json file
const configPath = path.join(__dirname, 'config.json');
let config = JSON.parse(fs.readFileSync(configPath));

// Extract configuration values
const nodes = config.nodes;
const rateLimitConfig = config.rateLimit;

const app = express();

// Port inside the container
const PORT = 8080;

// app.set('trust proxy', true);

// Enable CORS for all origins
app.use(cors());

// Middleware to assume 'Content-Type: application/json' if not provided
app.use((req, res, next) => {
  if (!req.headers['content-type']) {
    req.headers['content-type'] = 'application/json';
  }
  next();
});

// Configure body-parser to accept larger payloads
log(`Max Payload Size = ${config.max_payload_size}`);
app.use(bodyParser.json({ limit: config.max_payload_size })); // For JSON payloads
app.use(bodyParser.urlencoded({ limit: config.max_payload_size, extended: true })); // For URL-encoded payloads

// Configure rate limiting
const limiter = rateLimit({
  windowMs: rateLimitConfig.windowMs, // Time window in milliseconds
  max: rateLimitConfig.maxRequests,   // Max requests per windowMs
  message: { error: "Too Many Requests", errorCode: 429 },
  headers: true,
});

// Apply the rate limiting middleware to all requests
app.use(limiter);

// Parse JSON request bodies
app.use(express.json());

// user agent sent in the header
const user_agent = config.user_agent ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36";
// max jussi difference to check for validity
const max_jussi_number_diff = config.max_jussi_number_diff ?? 100; 
// min blockchain version
const min_blockchain_version = config.min_blockchain_version ?? "0.23.0";
// version
const proxy_version = config.version ?? "NA";
// max body length shown in logging
const loggging_max_body_len = config.loggging_max_body_len ?? 100;
// retry count for GET and POST forward
const retry_count = config.retry_count ?? 3;
log(`User-agent: ${user_agent}`);
log(`Max Jussi Number Difference: ${max_jussi_number_diff}`);
log(`Min Blockchain Version to Forward: ${min_blockchain_version}`);
log(`Version: ${proxy_version}`);
log(`Max Body Length Logging: ${loggging_max_body_len}`);
log(`Retry for GET and POST forward: ${retry_count}`);
log(`Nodes: ${config.nodes}`);
let current_max_jussi = -1;

// counters
let access_counters = new Map();
let error_counters = new Map();
let total_counter = 0;
let startTime = new Date();

log(`Current Time: ${startTime.toISOString()}`);

// Fetch version from the server
async function getVersion(server) {
  try {
    const response = await fetch(server, {
      method: 'POST',
      cache: 'no-cache',
      mode: 'cors',
      redirect: "follow",
      headers: { 'Content-Type': 'application/json', 'User-Agent': user_agent },
      body: JSON.stringify({
        id: 0,
        jsonrpc: "2.0",
        method: "call",
        params: ["login_api", "get_version", []]
      })
    });

    if (!response.ok) {
      let err_msg = `Server ${server} responded with status: ${response.status}`;
      log(err_msg);
      throw new Error(err_msg);
    }

    const jsonResponse = await response.json();
    const blockchain_version = jsonResponse["result"]["blockchain_version"];
    if (compareVersion(blockchain_version, min_blockchain_version) == -1) {
        let err_msg = `Server ${server} version = ${blockchain_version}: but min version is ${min_blockchain_version}`;
        log(err_msg);
        throw new Error(err_msg);
    }
    // log(jsonResponse);

    // let jussi_number = -1;
    // if (typeof jsonResponse.jussi_num === 'number' && Number.isInteger(jsonResponse.jussi_num)) {
    //   jussi_number = parseInt(jsonResponse.jussi_num);
    // }
    // if (jussi_number == -1) {
    //   let err_msg = `Server ${server} Invalid jussi_number value (not a number): ${jsonResponse.jussi_num}`;
    //   log(err_msg);
    //   throw new Error(err_msg);
    // }

    // if (jussi_number === 20000000) {
    //   let err_msg = `Server ${server} Invalid jussi_number value (20000000): ${jsonResponse.jussi_num}`;
    //   throw new Error(err_msg);
    // }
    // if (current_max_jussi <= jussi_number + max_jussi_number_diff) {
    //   current_max_jussi = jussi_number;
    // } else {
    //   let err_msg = `Server ${server} Invalid jussi_number value (less than ${current_max_jussi}): ${jsonResponse.jussi_num}`;
    //   log(err_msg);
    //   throw new Error(err_msg);
    // }

    return { server, version: jsonResponse };

  } catch (error) {
    let err_msg = `Server ${server} Failed to fetch version from ${server}: ${error.message} / ${jsonResponse}`;
    log(err_msg);
    throw new Error(err_msg);
  }
}

// Forward GET request to the chosen node
async function forwardRequestGET(apiURL) {
  for (let i = 0; i < retry_count; ++ i) {
    try {
      log(`GET: Forwarding to ${apiURL}`);
      const res = await fetch(apiURL, {
        method: 'GET',
        cache: 'no-cache',
        mode: 'cors',
        headers: { 'Content-Type': 'application/json', 'User-Agent': user_agent },
        redirect: "follow"
      });
      const data = await res.text();
      log(`Status: ${res.status}`);
      return { statusCode: res.status, data };
    } catch (error) {
      if (i < retry_count - 1) {
        log(`Retrying ${url}, attempt ${i + 1}`);
        await sleep(100);
        continue;
      }
      throw error;
    }
  }
}

// Forward POST request to the chosen node
async function forwardRequestPOST(apiURL, body) {
  for (let i = 0; i < retry_count; ++ i) {
    try {
      log(`POST: Forwarding to ${apiURL}, body=${limitStringMaxLength(body, loggging_max_body_len)}`);
      const res = await fetch(apiURL, {
        method: 'POST',
        cache: 'no-cache',
        mode: 'cors',
        headers: { 'Content-Type': 'application/json', 'User-Agent': user_agent },
        redirect: "follow",
        body: body
      });
      log(`Status: ${res.status}`);
      const data = await res.text();
      return { statusCode: res.status, data };
    } catch (error) {
      if (i < retry_count - 1) {
        log(`Retrying ${url}, attempt ${i + 1}`);
        await sleep(100);
        continue;
      }
      throw error;
    }
  }
}

app.head('/', (req, res, next) => {
    req.method = 'GET';
    next();
});

function calculatePercentage(accessCounters, totalCounter) {
  const percentageDict = {};

  for (let [url, count] of accessCounters) {
    let percentage = (count / total_counter) * 100;
    percentageDict[url] = {
      "percent": parseFloat(percentage.toFixed(2)),
      "count": count
    }
  }

  return percentageDict;
}

function calculateErrorPercentage(error_counters, access_counters) {
  const percentageDict = {};

  for (let [url, count] of error_counters) {
    let percentage = (count / access_counters.get(url)) * 100;
    percentageDict[url] = {
      "errRate": parseFloat(percentage.toFixed(2)),
      "total": access_counters.get(url),
      "errorCount": count,
      "succRate": parseFloat((100 - percentage).toFixed(2))
    }
  }

  return percentageDict;
}

// Handle incoming requests
app.all('/', async (req, res) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'Unknown IP';
  const method = req.method.toUpperCase();
  const shuffledNodes = shuffle(nodes);

  // Pick the fastest available node
  const promises = shuffledNodes.map(node => getVersion(node));
  let chosenNode = await Promise.any(promises).catch(() => ({ server: "https://api.steemit.com" }));

  log(`Request: ${ip}, ${method}: Chosen Node (version=${chosenNode.version["result"]["blockchain_version"]}): ${chosenNode.server}`);
  res.setHeader("IP", ip);
  res.setHeader("Server", chosenNode.server);
  if (typeof chosenNode.version !== "undefined") {
    res.setHeader("Version", JSON.stringify(chosenNode.version));
  }
  res.setHeader("LoadBalancerVersion", proxy_version);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (method === "GET") {
    if (typeof config.max_age !== "undefined") {
      res.setHeader('Cache-Control', 'max-age=' + config.max_age);
    }
  }
  let data = {};
  let result;

  // update stats
  total_counter ++;
  access_counters.set(chosenNode.server, (access_counters.get(chosenNode.server) ?? 0) + 1);
  let currentDate = new Date();
  let differenceInSeconds = Math.floor((currentDate - startTime) / 1000);
  const diff = secondsToTimeDict(differenceInSeconds)

  try {
    if (method === 'GET') {
      result = await forwardRequestGET(chosenNode.server);
    } else if (method === 'POST') {
      const body = JSON.stringify(req.body);
      log(`Request Body is ${limitStringMaxLength(body, loggging_max_body_len)}`);
      result = await forwardRequestPOST(chosenNode.server, body);
    } else {
      return res.status(405).json({ error: "Method Not Allowed" });
    }
    data = JSON.parse(result.data);
    if (method === 'GET') {
      data["status_code"] = 200;      
    }
  } catch (ex) {
    data = { 
      "status_code": 500,
      "error": ex,
      "__load_balancer_version__": proxy_version
    };
    res.setHeader('Error', JSON.stringify(ex));
    // set error counters - this is after max-retry
    error_counters.set(chosenNode.server, (error_counters.get(chosenNode.server) ?? 0) + 1);
  }
  if (method === 'GET') {
    data["__server__"] = chosenNode.server;
    data["__version__"] = chosenNode.version;
    data["__servers__"] = config.nodes;
    data["__ip__"] = ip;
    data["__load_balancer_version__"] = proxy_version;
    data["__stats__"] = {
      "total": total_counter,
      "rps": parseFloat((total_counter / diff.seconds).toFixed(2)),
      "uptime": {
        "startTime": startTime,
        "currentTime": currentDate,
        "seconds": diff.seconds,
        "minutes": diff.minutes,
        "hours": diff.hours,
        "days": diff.days,
        "month": diff.months,
        "year": diff.years
      },
      "access_counters": calculatePercentage(access_counters, total_counter),
      "error_counters": calculateErrorPercentage(error_counters, access_counters)
    }
  }
  if (!result || (typeof result === "undefined")) {
    res.status(500).json(data);
    return;
  }
  if (!result.statusCode || (typeof result.statusCode === "undefined")) {
    res.status(500).json(data);
    return;
  }
  res.status(result.statusCode).json(data);
});

// Define the server variable to use for shutdown
let server;

// Determine if SSL certificates exist
const sslCertPath = config.sslCertPath;
const sslKeyPath = config.sslKeyPath;
log(`sslCertPath = ${sslCertPath}`);
log(`sslKeyPath = ${sslKeyPath}`);

if (fs.existsSync(sslCertPath) && fs.existsSync(sslKeyPath)) {
  // SSL certificates are available; create HTTPS server
  const options = {
    key: fs.readFileSync(sslKeyPath),
    cert: fs.readFileSync(sslCertPath)
  };

  server = https.createServer(options, app);

  server.listen(PORT, () => {
    console.log(`HTTPS server is running on https://localhost:${PORT}`);
  });

} else {
  // SSL certificates are not available; create HTTP server
  server = http.createServer(app);

  server.listen(PORT, () => {
    console.log(`HTTP server is running on http://localhost:${PORT}`);
  });
}

// Graceful shutdown on Ctrl+C
process.on('SIGINT', () => {
  console.log("\nGracefully shutting down...");
  server.close(() => {
    console.log("Server closed.");
    process.exit(0); // Exit the process after server is closed
  });
});

// Graceful shutdown on SIGTERM
process.on('SIGTERM', () => {
  console.log("\nGracefully shutting down on SIGTERM...");
  server.close(() => {
    console.log("Server closed.");
    process.exit(0); // Exit the process after server is closed
  });
});
