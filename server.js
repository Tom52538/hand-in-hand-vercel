const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const { createClient } = require('@supabase/supabase-js');
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(express.static('public'));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dein-geheimes-schluessel',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

// Supabase-Client initialisieren
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Hinweis: Die Tabelle "work_hours" sollte bereits in deiner Supabase-Datenbank angelegt sein.

// Middleware zur Überprüfung, ob der User Admin ist
function isAdmin(req, res, next) {
  if (req.session.isAdmin) {
    next();
  } else {
    res.status(403).send('Access denied. Admin privileges required.');
  }
}

// GET /admin-work-hours – alle Arbeitszeiten (Admin)
app.get('/admin-work-hours', isAdmin, async (req, res) => {
  const { data, error } = await supabase.from('work_hours').select('*');
  if (error) return res.status(500).send('Error fetching work hours.');
  res.json(data);
});

// GET /admin-download-csv – CSV-Download (Admin)
app.get('/admin-download-csv', isAdmin, async (req, res) => {
  const { data, error } = await supabase.from('work_hours').select('*');
  if (error) return res.status(500).send('Error fetching work hours.');
  const csv = convertToCSV(data);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="arbeitszeiten.csv"');
  res.send(csv);
});

// PUT /api/admin/update-hours – Arbeitszeit aktualisieren (Admin)
app.put('/api/admin/update-hours', isAdmin, async (req, res) => {
  const { id, name, date, startTime, endTime, comment } = req.body;
  if (startTime >= endTime) {
    return res.status(400).json({ error: 'Arbeitsbeginn darf nicht später als Arbeitsende sein.' });
  }
  const hours = calculateWorkHours(startTime, endTime);
  const breakTime = calculateBreakTime(hours, comment);
  const netHours = hours - breakTime;

  const { error } = await supabase.from('work_hours')
    .update({ name, date, hours: netHours, break_time: breakTime, comment, startTime, endTime })
    .eq('id', id);
  if (error) return res.status(500).send('Error updating working hours.');
  res.send('Working hours updated successfully.');
});

// DELETE /api/admin/delete-hours/:id – Einzelne Arbeitszeit löschen (Admin)
app.delete('/api/admin/delete-hours/:id', isAdmin, async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('work_hours').delete().eq('id', id);
  if (error) return res.status(500).send('Error deleting working hours.');
  res.send('Working hours deleted successfully.');
});

// POST /log-hours – Arbeitszeit erfassen
app.post('/log-hours', async (req, res) => {
  const { name, date, startTime, endTime, comment } = req.body;
  if (startTime >= endTime) {
    return res.status(400).json({ error: 'Arbeitsbeginn darf nicht später als Arbeitsende sein.' });
  }
  // Prüfen, ob bereits ein Eintrag existiert (case-insensitive)
  const { data: existing, error: checkError } = await supabase.from('work_hours')
    .select('*')
    .ilike('name', name)
    .eq('date', date);
  if (checkError) return res.status(500).send('Fehler beim Überprüfen der Daten.');
  if (existing && existing.length > 0) {
    return res.status(400).json({ error: 'Eintrag für diesen Tag existiert bereits.' });
  }
  const hours = calculateWorkHours(startTime, endTime);
  const breakTime = calculateBreakTime(hours, comment);
  const netHours = hours - breakTime;

  const { error } = await supabase.from('work_hours')
    .insert([{ name, date, hours: netHours, break_time: breakTime, comment, startTime, endTime }]);
  if (error) return res.status(500).send('Fehler beim Speichern der Daten.');
  res.send('Daten erfolgreich gespeichert.');
});

// GET /get-all-hours – Alle Arbeitszeiten für einen Namen abrufen
app.get('/get-all-hours', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).send('Name ist erforderlich.');
  const { data, error } = await supabase.from('work_hours')
    .select('*')
    .ilike('name', name)
    .order('date', { ascending: true });
  if (error) return res.status(500).send('Fehler beim Abrufen der Daten.');
  res.json(data);
});

// GET /get-hours – Einen Datensatz für Name + Datum abrufen
app.get('/get-hours', async (req, res) => {
  const { name, date } = req.query;
  const { data, error } = await supabase.from('work_hours')
    .select('*')
    .ilike('name', name)
    .eq('date', date)
    .single();
  if (error) return res.status(500).send('Fehler beim Abrufen der Daten.');
  if (!data) return res.status(404).send('Keine Daten gefunden.');
  res.json(data);
});

// DELETE /delete-hours – Alle Arbeitszeiten löschen (Passwort-geschützt)
app.delete('/delete-hours', async (req, res) => {
  const { password, confirm } = req.body;
  if (password === 'dein-passwort' && confirm === true) {
    const { error } = await supabase.from('work_hours').delete().neq('id', 0);
    if (error) return res.status(500).send('Fehler beim Löschen der Daten.');
    res.send('Daten erfolgreich gelöscht.');
  } else {\n    res.status(401).send('Löschen abgebrochen. Passwort erforderlich oder Bestätigung fehlt.');\n  }\n});

// POST /admin-login – Admin-Login
app.post('/admin-login', (req, res) => {
  const { password } = req.body;
  if (password === 'admin') {\n    req.session.isAdmin = true;\n    res.send('Admin angemeldet.');\n  } else {\n    res.status(401).send('Ungültiges Passwort.');\n  }\n});

// Hilfsfunktionen
function calculateWorkHours(startTime, endTime) {
  const start = new Date(`1970-01-01T${startTime}:00`);
  const end = new Date(`1970-01-01T${endTime}:00`);
  return (end - start) / (1000 * 60 * 60);
}

function calculateBreakTime(hours, comment) {
  if (comment && (comment.toLowerCase().includes('ohne pause') || comment.toLowerCase().includes('keine pause'))) {
    return 0;
  } else if (comment && comment.toLowerCase().includes('15 minuten')) {
    return 0.25;
  } else if (hours > 9) {
    return 0.75;
  } else if (hours > 6) {
    return 0.5;
  } else {
    return 0;
  }
}

function convertDecimalHoursToHoursMinutes(decimalHours) {
  const hours = Math.floor(decimalHours);
  const minutes = Math.round((decimalHours - hours) * 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function convertToCSV(data) {
  if (!data || data.length === 0) return '';
  const csvRows = [];
  const headers = ['Name', 'Datum', 'Anfang', 'Ende', 'Gesamtzeit', 'Bemerkung'];
  csvRows.push(headers.join(','));
  data.forEach(row => {
    const formattedHours = convertDecimalHoursToHoursMinutes(row.hours);
    const values = [
      row.name,
      row.date,
      row.startTime,
      row.endTime,
      formattedHours,
      row.comment || ''
    ];
    csvRows.push(values.join(','));
  });
  return csvRows.join('\n');
}

// Server starten oder als Serverless-Funktion exportieren
if (process.env.VERCEL) {
  module.exports = app;
} else {
  app.listen(port, () => console.log(`Server läuft auf http://localhost:${port}`));
}
