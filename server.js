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

// Middleware to check if the user is an admin
function isAdmin(req, res, next) {
    const isAdminUser = req.session.isAdmin;
    if (isAdminUser) {
        next();
    } else {
        res.status(403).send('Access denied. Admin privileges required.');
    }
}

// New route to fetch all work hours for admin
app.get('/admin-work-hours', isAdmin, (req, res) => {
    const query = 'SELECT * FROM work_hours';
    db.all(query, [], (err, rows) => {
        if (err) {
            return res.status(500).send('Error fetching work hours.');
        }
        res.json(rows);
    });
});

// New route to download all work hours as CSV for admin
app.get('/admin-download-csv', isAdmin, (req, res) => {
    const query = 'SELECT * FROM work_hours';
    db.all(query, [], (err, rows) => {
        if (err) {
            return res.status(500).send('Error fetching work hours.');
        }
        const csv = convertToCSV(rows);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="arbeitszeiten.csv"');
        res.send(csv);
    });
});

// Update-Endpunkt
app.put('/api/admin/update-hours', isAdmin, (req, res) => {
    const { id, name, date, hours, comment } = req.body;
    const query = 'UPDATE work_hours SET name = ?, date = ?, hours = ?, comment = ? WHERE id = ?';
    db.run(query, [name, date, hours, comment, id], function(err) {
        if (err) {
            return res.status(500).send('Error updating working hours.');
        }
        res.send('Working hours updated successfully.');
    });
});

// Delete-Endpunkt
app.delete('/api/admin/delete-hours/:id', isAdmin, (req, res) => {
    const { id } = req.params;
    const query = 'DELETE FROM work_hours WHERE id = ?';
    db.run(query, [id], function(err) {
        if (err) {
            return res.status(500).send('Error deleting working hours.');
        }
        res.send('Working hours deleted successfully.');
    });
});

// API Endpunkt zum Erfassen der Arbeitszeiten
app.post('/log-hours', (req, res) => {
  const { name, date, startTime, endTime, comment } = req.body;

  // Überprüfen, ob Arbeitsbeginn vor Arbeitsende liegt
  if (startTime >= endTime) {
    return res.status(400).json({ error: 'Arbeitsbeginn darf nicht später als Arbeitsende sein.' });
  }

  // Überprüfen, ob bereits ein Eintrag für denselben Tag und Mitarbeiter existiert
  const checkQuery = 'SELECT * FROM work_hours WHERE name = ? AND date = ?';
  db.get(checkQuery, [name, date], (err, row) => {
    if (err) {
      return res.status(500).send('Fehler beim Überprüfen der Daten.');
    }

    if (row) {
      return res.status(400).json({ error: 'Eintrag für diesen Tag existiert bereits.' });
    }

    const hours = calculateWorkHours(startTime, endTime);
    const breakTime = calculateBreakTime(hours, comment);
    const netHours = hours - breakTime;

    const insertQuery = 'INSERT INTO work_hours (name, date, hours, break_time, comment, startTime, endTime) VALUES (?, ?, ?, ?, ?, ?, ?)';
    db.run(insertQuery, [name, date, netHours, breakTime, comment, startTime, endTime], function(err) {
      if (err) {
        return res.status(500).send('Fehler beim Speichern der Daten.');
      }
      res.send('Daten erfolgreich gespeichert.');
    });
  });
});

// API Endpunkt zum Abrufen der Arbeitszeiten
app.get('/get-hours', (req, res) => {
  const { name, date } = req.query;
  const query = 'SELECT * FROM work_hours WHERE name = ? AND date = ?';
  db.get(query, [name, date], (err, row) => {
    if (err) {
      return res.status(500).send('Fehler beim Abrufen der Daten.');
    }
    if (!row) {
      return res.status(404).send('Keine Daten gefunden.');
    }
    res.json(row);
  });
});

// API Endpunkt zum Löschen der Arbeitszeiten
app.delete('/delete-hours', (req, res) => {
  const { password, confirm } = req.body;
  if (password === 'dein-passwort' && confirm === true) {
    const deleteQuery = 'DELETE FROM work_hours';
    db.run(deleteQuery, function(err) {
      if (err) {
        return res.status(500).send('Fehler beim Löschen der Daten.');
      }
      res.send('Daten erfolgreich gelöscht.');
    });
  } else {
    res.status(401).send('Löschen abgebrochen. Passwort erforderlich oder Bestätigung fehlt.');
  }
});

// Admin Login Endpunkt
app.post('/admin-login', (req, res) => {
    const { password } = req.body;
    if (password === 'admin') {
        req.session.isAdmin = true;
        res.send('Admin angemeldet.');
    } else {
        res.status(401).send('Ungültiges Passwort.');
    }
});

// Hilfsfunktionen
function calculateWorkHours(startTime, endTime) {
  const start = new Date(`1970-01-01T${startTime}:00`);
  const end = new Date(`1970-01-01T${endTime}:00`);
  const diff = end - start;
  return diff / 1000 / 60 / 60; // Stunden
}

function calculateBreakTime(hours, comment) {
  if (comment && (comment.toLowerCase().includes("ohne pause") || comment.toLowerCase().includes("keine pause"))) {
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

function convertDecimalHoursToHoursMinutes(decimalHours) {
  const hours = Math.floor(decimalHours);
  const minutes = Math.round((decimalHours - hours) * 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function convertToCSV(data) {
  if (!data || data.length === 0) {
    return '';
  }
  const csvRows = [];
  const headers = ["Name", "Datum", "Anfang", "Ende", "Gesamtzeit", "Bemerkung"];
  csvRows.push(headers.join(','));

  for (const row of data) {
    const formattedHours = convertDecimalHoursToHoursMinutes(row.hours);

    const values = [
      row.name,
      row.date,
      row.startTime,
      row.endTime,
      formattedHours, // Formatiert als Stunden:Minuten
      row.comment || ''
    ];
    csvRows.push(values.join(','));
  }

  return csvRows.join('\n');
}

// Server starten
app.listen(port, () => {
  console.log(`Server läuft auf http://localhost:${port}`);
});
