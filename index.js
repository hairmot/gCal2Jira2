const fs = require('fs');
const { google } = require('googleapis');
const readline = require("readline");
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
const fetch = require('node-fetch')
const btoa = require('btoa')
const https = require('https');
const creds = require('./credentials');


const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];
// The file token.json stores the user's access and refresh tokens, and is
// created automatically when the authorization flow completes for the first
// time.
const TOKEN_PATH = 'token.json';


// Authorize a client with credentials, then call the Google Calendar API.
authorize(creds, listEvents);


/**
 * Create an OAuth2 client with the given credentials, and then execute the
 * given callback function.
 * @param {Object} credentials The authorization client credentials.
 * @param {function} callback The callback to call with the authorized client.
 */
function authorize(credentials, callback) {
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(
    client_id, client_secret, redirect_uris[0]);

  // Check if we have previously stored a token.
  fs.readFile(TOKEN_PATH, (err, token) => {
    if (err) return getAccessToken(oAuth2Client, callback);
    oAuth2Client.setCredentials(JSON.parse(token));
    callback(oAuth2Client);
  });
}

/**
 * Get and store new token after prompting for user authorization, and then
 * execute the given callback with the authorized OAuth2 client.
 * @param {google.auth.OAuth2} oAuth2Client The OAuth2 client to get token for.
 * @param {getEventsCallback} callback The callback for the authorized client.
 */
function getAccessToken(oAuth2Client, callback) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  console.log('We need to authenticate with Google. Authorize this app by visiting this url:', authUrl);

  rl.question('Enter the code from that page here: ', (code) => {
    //rl.close();
    oAuth2Client.getToken(code, (err, token) => {
      if (err) return console.error('Error retrieving access token', err);
      oAuth2Client.setCredentials(token);
      // Store the token to disk for later program executions
      fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
        if (err) return console.error(err);
      
      });
      callback(oAuth2Client);
    });
  });
}

/**
 * Lists the next 10 events on the user's primary calendar.
 * @param {google.auth.OAuth2} auth An authorized OAuth2 client.
 */
async function listEvents(auth) {
  var days = await new Promise(resolve => {
    rl.question('How many days should I go back?: ', function (num) {
      var answer = parseInt(num)
      if(isNaN(answer) || answer == '' || answer < 1 || answer > 40 ) {
        console.error('invalid number')
        resolve(7)
      }
      else {
        resolve(answer)
      }
      
    })
  })

  var review = await new Promise(resolve => {
    rl.question('Do you want to review entries? [yes]/no: ', answer => {
      if (answer === 'yes' | answer === '') {
        resolve(true)
      }
      resolve(false)
    });
  })


  var questions = [];
  const calendar = google.calendar({ version: 'v3', auth });
  calendar.events.list({
    calendarId: 'primary',
    timeMax: (function () { var d = new Date(); d.setDate(d.getDate() + 1); return d })().toISOString(),
    maxResults: 500,
    singleEvents: true,
    timeMin: (function () { var d = new Date(); d.setDate(d.getDate() - days); return d })().toISOString(),
    orderBy: 'startTime',
  }, (err, res) => {
    if (err) return console.error('The API returned an error: ' + err);
    const events = res.data.items;
    if (events.length) {
      events.map((event, i) => {
        const start = event.start.dateTime || event.start.date;
        var pattern = /#SLPDEV-\d+/g;
        if (event.attendees && event.attendees.filter(a => a.self)[0].comment && event.attendees.filter(a => a.self)[0].comment.match(pattern)) {
          questions.push({ event: event, text: event.summary, ids: event.attendees.filter(a => a.self)[0].comment.match(pattern) })
        }
        else if (event.description && event.description.match(pattern)) {
          questions.push({ event: event, text: event.summary, ids: event.description.match(pattern) })
        }        
      });
      if (questions.length > 0) {
        logEvents(questions, review)
      }
      else {
        console.log('No entries found - have you marked up calendar entries with #SLPDEV-{ID} in either the description or note?')
        rl.close()
      }
    } else {
      console.log('No Events');
    }
  });
}

async function logEvents(questions, review) {
  let answers = [];
  for (let item of questions) {
    var jiraTicket = item.ids.map(a => a.substring(1, a.length))[0]
    var startTime = new Date(item.event.start.dateTime)
    var endTime = new Date(item.event.end.dateTime)
    var timeInMinutes = ((endTime - startTime) / 1000) / 60
    question = `Log ${timeInMinutes} minutes against ${jiraTicket} for "${item.text}"? [yes]/no: `
    answers.push(
      review ? 
      await new Promise(resolve => {
        rl.question(question, answer => {
          if (answer === 'yes' | answer === '') {
            resolve({ jiraTicket: jiraTicket, text: item.text, minutes: timeInMinutes, date: item.event.start.dateTime });
          }
          resolve(false)
        });
      })
      : { jiraTicket: jiraTicket, text: item.text, minutes: timeInMinutes, date: item.event.start.dateTime }
    );
  }

  var username = await new Promise(resolve => {
    rl.question('Please enter your JIRA username: ', function (answer) {
      resolve(answer)
    })
  })
  rl.input.on("keypress", function (c, k) {
    // get the number of characters entered so far:
    var len = rl.line.length;
    // move cursor back to the beginning of the input:
    readline.moveCursor(rl.output, -len, 0);
    // clear everything to the right of the cursor:
    readline.clearLine(rl.output, 1);
    // replace the original input with asterisks:
    for (var i = 0; i < len; i++) {
      rl.output.write("*");
    }
  });

  var password = await new Promise(resolve => {
    rl.question('Please enter your JIRA password: ', function (answer) {
      resolve(answer)
    })
  })
  rl.close()
  answers.filter(a => a).map(a => logEvent(a.jiraTicket, a.text, a.minutes, a.date, username, password))
  console.log('Done')
}

async function logEvent(event, text, minutes, date, username, password) {
  var body = {
    "timeSpentSeconds": minutes * 60,
    "started": (new Date(date)).toISOString().replace('Z', '') + '+0000',
    "comment": "Automated log from calendar: " + text
  };
  const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
  });

  //check if it already is logged
    await fetch(`https://jira.shef.ac.uk/rest/api/latest/issue/${event}/worklog`, {
    method: 'get',
    agent: httpsAgent,
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + btoa(username + ':' + password) },
  })
  .then(data => data.json())
  .then(async function(data) {
    var logs = data.worklogs.filter(a => (a.timeSpentSeconds === minutes * 60) && a.started === (new Date(date)).toISOString().replace('Z', '') + '+0000' && a.author.name === username) 
    if(logs.length == 0) {
      //don't log duplicates
      await fetch(`https://jira.shef.ac.uk/rest/api/latest/issue/${event}/worklog`, {
        method: 'post',
        agent: httpsAgent,
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + btoa(username + ':' + password) },
      })
    }  
  })
}