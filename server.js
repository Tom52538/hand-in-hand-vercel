const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');
const app = express();
const port = 3000;

// Middleware
app.use(bodyParser.json());
app.use(express.static('public'));

// SQLite Datenbank einrichten
const db = new sqlite3.Database(':memory:');

db.serialize(() => {
  db.run("CREATE TABLE work_hours (id INTEGER PRIMARY KEY, name TEXT, date TEXT, hours REAL, break_time REAL)");
});

// API Endpunkte
app.post('/log-hours', (req, res) => {
  const { name, date, hours } = req.body;
  const breakTime = calculateBreakTime(hours);

  const stmt = db.prepare("INSERT INTO work_hours (name, date, hours, break_time) VALUES (?, ?, ?, ?)");
  stmt.run(name, date, hours, breakTime, function(err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ id: this.lastID });
  });
  stmt.finalize();
});

app.get('/work-hours', (req, res) => {
  db.all("SELECT * FROM work_hours", [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ workHours: rows });
  });
});

app.get('/download-csv', (req, res) => {
  db.all("SELECT * FROM work_hours", [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    const csv = convertToCSV(rows);
    res.header('Content-Type', 'text/csv');
    res.attachment('work_hours.csv');
    return res.send(csv);
  });
});

// Startseite bereitstellen
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Hilfsfunktionen
function calculateBreakTime(hours) {
  // Beispiel: 30 Minuten Pause für jede 6 Stunden Arbeit
  return Math.floor(hours / 6) * 0.5;
}

function convertToCSV(data) {
  const csvRows = [];
  const headers = Object.keys(data[0]);
  csvRows.push(headers.join(','));

  for (const row of data) {
    const values = headers.map(header => row[header]);
    csvRows.push(values.join(','));
  }

  return csvRows.join('\n');
}

// Server starten
app.listen(port, () => {
  console.log(`Server läuft auf http://localhost:${port}`);
});
