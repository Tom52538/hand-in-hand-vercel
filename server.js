const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const session = require('express-session');
const path = require('path');
const app = express();
const port = 3000;

// Middleware
app.use(bodyParser.json());
app.use(express.static('public'));

// Session-Middleware konfigurieren
app.use(session({
  secret: 'dein-geheimes-schluessel', // Ersetze dies durch einen sicheren Schlüssel
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Setze auf true, wenn du HTTPS verwendest
}));

// SQLite Datenbank einrichten
const db = new sqlite3.Database('./work_hours.db');

db.serialize(() => {
  db.run("CREATE TABLE IF NOT EXISTS work_hours (id INTEGER PRIMARY KEY, name TEXT, date TEXT, hours REAL, break_time REAL, comment TEXT, startTime TEXT, endTime TEXT)");

  // Füge die 'comment', 'startTime', 'endTime' Felder hinzu, falls sie noch nicht existieren
  db.all("PRAGMA table_info(work_hours)", [], (err, rows) => {
    if (err) {
      console.error("Fehler beim Abrufen der Tabelleninformationen:", err);
      return;
    }

    const columnNames = rows.map(row => row.name);
    if (!columnNames.includes('comment')) {
      db.run("ALTER TABLE work_hours ADD COLUMN comment TEXT");
    }
    if (!columnNames.includes('startTime')) {
      db.run("ALTER TABLE work_hours ADD COLUMN startTime TEXT");
    }
    if (!columnNames.includes('endTime')) {
      db.run("ALTER TABLE work_hours ADD COLUMN endTime TEXT");
    }
  });
});

// API Endpunkte
app.post('/log-hours', (req, res) => {
  const { name, date, startTime, endTime, comment } = req.body;

  // Name case-insensitive machen
  const lowerCaseName = name.toLowerCase();

  // Überprüfen, ob bereits ein Eintrag für den Mitarbeiter an diesem Datum existiert
  db.get("SELECT * FROM work_hours WHERE LOWER(name) = ? AND date = ?", [lowerCaseName, date], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (row) {
      return res.status(400).json({ error: 'Es existiert bereits ein Eintrag für diesen Mitarbeiter an diesem Datum.' });
    }

    // Überprüfen, ob Arbeitsbeginn vor Arbeitsende liegt
    if (startTime >= endTime) {
      return res.status(400).json({ error: 'Arbeitsbeginn darf nicht später als Arbeitsende sein.' });
    }

    const totalHours = calculateWorkHours(startTime, endTime);
    const breakTime = calculateBreakTime(totalHours, comment);
    const netHours = totalHours - breakTime;

    const stmt = db.prepare("INSERT INTO work_hours (name, date, hours, break_time, comment, startTime, endTime) VALUES (?, ?, ?, ?, ?, ?, ?)");
    stmt.run(name, date, netHours, breakTime, comment || '', startTime, endTime, function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ id: this.lastID });
    });
    stmt.finalize();
  });
});

app.get('/work-hours', (req, res) => {
  const name = req.query.name;
  const query = "SELECT * FROM work_hours WHERE LOWER(name) = ?";
  db.all(query, [name.toLowerCase()], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    const formattedRows = rows.map(row => ({
      name: row.name,
      date: row.date,
      startTime: row.startTime,
      endTime: row.endTime,
      hours: `${row.hours} Stunden`,
      comment: row.comment || ''
    }));
    res.json({ workHours: formattedRows });
  });
});

app.post('/admin-login', (req, res) => {
  const { password } = req.body;
  if (password === 'admin') {
    req.session.admin = true;
    res.json({ message: 'Admin login successful' });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

app.get('/admin/work-hours', (req, res) => {
  if (!req.session.admin) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  db.all("SELECT * FROM work_hours", [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    const formattedRows = rows.map(row => ({
      ...row,
      hours: formatHours(row.hours),
      break_time: formatHours(row.break_time)
    }));
    res.json({ workHours: formattedRows });
  });
});

app.get('/admin/download-csv', (req, res) => {
  if (!req.session.admin) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  db.all("SELECT * FROM work_hours", [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (rows.length > 0) {
      const csv = convertToCSV(rows);
      res.header('Content-Type', 'text/csv');
      res.attachment('arbeitszeiten.csv');
      return res.send(csv);
    } else {
      res.status(404).json({ error: 'No data available' });
    }
  });
});

// Startseite bereitstellen
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Hilfsfunktionen
function calculateWorkHours(startTime, endTime) {
  const start = new Date(`1970-01-01T${startTime}:00`);
  const end = new Date(`1970-01-01T${endTime}:00`);
  const diff = end - start;
  return diff / 1000 / 60 / 60; // Stunden
}

function calculateBreakTime(hours, comment) {
  if (comment && comment.toLowerCase().includes("ohne pause")) {
    return 0;
  } else if (comment && comment.toLowerCase().includes("15 minuten")) {
    return 0.25; // 15 Minuten Pause
  } else if (hours > 9) {
    return 0.75; // 45 Minuten Pause
  } else if (hours > 6) {
    return 0.5; // 30 Minuten Pause
  } else {
    return 0; // Keine Pause erforderlich
  }
}

function formatHours(hours) {
  const minutes = Math.round((hours % 1) * 60);
  const formattedHours = Math.floor(hours);
  return `${formattedHours}h ${minutes}min`;
}

function convertToCSV(data) {
  if (!data || data.length === 0) {
    return '';
  }
  const csvRows = [];
  const headers = ["Name", "Datum", "Anfang", "Ende", "Gesamtzeit", "Bemerkung"];
  csvRows.push(headers.join(','));

  for (const row of data) {
    const values = [
      row.name,
      row.date,
      formatTime(row.startTime),
      formatTime(row.endTime),
      `${row.hours} Stunden`,
      row.comment || ''
    ];
    csvRows.push(values.join(','));
  }

  return csvRows.join('\n');
}

function formatTime(time) {
  return time.padStart(2, '0') + ":00";
}

// Server starten
app.listen(port, () => {
  console.log(`Server läuft auf http://localhost:${port}`);
});
