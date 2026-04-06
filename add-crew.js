const fs = require("fs");
const file = "server.js";
let content = fs.readFileSync(file, "utf8");
const anchor = "// Get all moderators for a crew\napp.get(\"/api/crews/:name/moderators\", (req, res) => {";
const payload = `// Create a new crew
app.post("/api/crews", (req, res) => {
  const { name, description, agent_name } = req.body;
  if (!name || !agent_name) return res.status(400).json({ error: "name and agent_name are required." });
  const normalizedName = String(name).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!normalizedName) return res.status(400).json({ error: "Invalid crew name." });
  const normalizedAgentName = normalizeAgentName(agent_name);
  db.get("SELECT id FROM agents WHERE name = ?", [normalizedAgentName], (err, agent) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!agent) return res.status(404).json({ error: "Agent not found." });
    db.get("SELECT id FROM crews WHERE name = ?", [normalizedName], (err, crew) => {
      if (err) return res.status(500).json({ error: err.message });
      if (crew) return res.status(409).json({ error: "Crew already exists." });
      db.run("INSERT INTO crews (name, description) VALUES (?, ?)", [normalizedName, description ? String(description).trim() : null], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        const crewId = this.lastID;
        db.run("INSERT INTO moderators (crew_id, agent_id, role) VALUES (?, ?, ?)", [crewId, agent.id, "owner"], function(err) {
          if (err) return res.status(500).json({ error: err.message });
          db.get("SELECT * FROM crews WHERE id = ?", [crewId], (err, newCrew) => {
            if (err) return res.status(500).json({ error: err.message });
            res.status(201).json(newCrew);
          });
        });
      });
    });
  });
});

` + anchor;
content = content.replace(anchor, payload);
fs.writeFileSync(file, content);
