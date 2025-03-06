const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL-Datenbankverbindung
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// PostgreSQL-Tabelle für Arbeitszeiten erstellen
db.query(`
  CREATE TABLE IF NOT EXISTS work_hours (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    date TEXT NOT NULL,
    hours REAL NOT NULL,
    break_time REAL NOT NULL,
    comment TEXT,
    startTime TEXT NOT NULL,
    endTime TEXT NOT NULL
  )
`, (err) => {
  if (err) console.error("Fehler beim Erstellen der Tabelle:", err);
  else console.log("Tabelle 'work_hours' überprüft oder erstellt.");
});

// PostgreSQL-Tabelle für Sessions erstellen
db.query(`
  CREATE TABLE IF NOT EXISTS user_sessions (
    sid VARCHAR PRIMARY KEY,
    sess JSON NOT NULL,
    expire TIMESTAMPTZ NOT NULL
  )
`, (err) => {
  if (err) console.error("Fehler beim Erstellen der Session-Tabelle:", err);
  else console.log("Tabelle 'user_sessions' überprüft oder erstellt.");
});

// Session-Middleware mit PostgreSQL
app.use(session({
  store: new PgSession({
    pool: db,
    tableName: 'user_sessions'
  }),
  secret: 'dein-geheimes-schluessel',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

// Middleware für Admin-Check
function isAdmin(req, res, next) {
  if (req.session.isAdmin) {
    return next();
  } else {
    return res.status(403).send('Access denied. Admin privileges required.');
  }
}

// API-Endpunkt zum Erfassen der Arbeitszeiten
app.post('/log-hours', async (req, res) => {
  const { name, date, startTime, endTime, comment } = req.body;

  if (startTime >= endTime) {
    return res.status(400).json({ error: 'Arbeitsbeginn darf nicht später als Arbeitsende sein.' });
  }

  const hours = calculateWorkHours(startTime, endTime);
  const breakTime = calculateBreakTime(hours, comment);
  const netHours = hours - breakTime;

  try {
    await db.query(
      'INSERT INTO work_hours (name, date, hours, break_time, comment, startTime, endTime) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [name, date, netHours, breakTime, comment, startTime, endTime]
    );
    res.send('Daten erfolgreich gespeichert.');
  } catch (err) {
    console.error('Fehler beim Speichern der Daten:', err);
    res.status(500).send('Fehler beim Speichern der Daten.');
  }
});

// API-Endpunkt zum Abrufen der Arbeitszeiten
app.get('/get-hours', async (req, res) => {
  const { name, date } = req.query;

  try {
    const result = await db.query('SELECT * FROM work_hours WHERE name = $1 AND date = $2', [name, date]);
    if (result.rows.length === 0) {
      return res.status(404).send('Keine Daten gefunden.');
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Fehler beim Abrufen der Daten:', err);
    res.status(500).send('Fehler beim Abrufen der Daten.');
  }
});

// Admin-Login
app.post('/admin-login', (req, res) => {
  const { password } = req.body;
  if (password === 'admin') {
    req.session.isAdmin = true;
    res.send('Admin angemeldet.');
  } else {
    res.status(401).send('Ungültiges Passwort.');
  }
});

// Admin: Alle Arbeitszeiten abrufen
app.get('/admin-work-hours', isAdmin, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM work_hours');
    res.json(result.rows);
  } catch (err) {
    console.error('Fehler beim Abrufen der Daten:', err);
    res.status(500).send('Fehler beim Abrufen der Daten.');
  }
});

// Admin: CSV-Download
app.get('/admin-download-csv', isAdmin, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM work_hours');
    const csvData = convertToCSV(result.rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="arbeitszeiten.csv"');
    res.send(csvData);
  } catch (err) {
    console.error('Fehler beim CSV-Export:', err);
    res.status(500).send('Fehler beim CSV-Export.');
  }
});

// Admin: Eintrag löschen
app.delete('/api/admin/delete-hours/:id', isAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    await db.query('DELETE FROM work_hours WHERE id = $1', [id]);
    res.send('Arbeitszeiten erfolgreich gelöscht.');
  } catch (err) {
    console.error('Fehler beim Löschen der Daten:', err);
    res.status(500).send('Fehler beim Löschen der Daten.');
  }
});

// Server starten
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});

// Hilfsfunktionen
function calculateWorkHours(startTime, endTime) {
  const start = new Date(`1970-01-01T${startTime}:00`);
  const end = new Date(`1970-01-01T${endTime}:00`);
  return (end - start) / (1000 * 60 * 60); // Stunden
}

function calculateBreakTime(hours, comment) {
  if (comment && (comment.toLowerCase().includes("ohne pause") || comment.toLowerCase().includes("keine pause"))) {
    return 0;
  } else if (comment && comment.toLowerCase().includes("15 minuten")) {
    return 0.25;
  } else if (hours > 9) {
    return 0.75;
  } else if (hours > 6) {
    return 0.5;
  } else {
    return 0;
  }
}

function convertToCSV(data) {
  if (!data || data.length === 0) {
    return '';
  }
  const csvRows = [];
  const headers = ["Name", "Datum", "Start", "Ende", "Gesamtstunden", "Bemerkung"];
  csvRows.push(headers.join(','));

  for (const row of data) {
    const values = [row.name, row.date, row.startTime, row.endTime, row.hours, row.comment || ''];
    csvRows.push(values.join(','));
  }
  return csvRows.join('\n');
}
