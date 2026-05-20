//! Mail server configuration.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailConfig {
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_user: String,
    pub imap_pass: String,
    pub max_emails: usize,
    pub server_port: u16,
    pub ngrok_token: Option<String>,
    pub ngrok_domain: Option<String>,
}

impl Default for MailConfig {
    fn default() -> Self {
        Self {
            imap_host: "imap.mail.me.com".to_string(),
            imap_port: 993,
            imap_user: String::new(),
            imap_pass: String::new(),
            max_emails: 500,
            server_port: 5000,
            ngrok_token: None,
            ngrok_domain: None,
        }
    }
}

impl MailConfig {
    /// Load from a JSON file, or return None if not found.
    pub fn load(path: &std::path::Path) -> Option<Self> {
        let data = std::fs::read_to_string(path).ok()?;
        serde_json::from_str(&data).ok()
    }

    /// Save to a JSON file.
    pub fn save(&self, path: &std::path::Path) -> anyhow::Result<()> {
        let data = serde_json::to_string_pretty(self)?;
        std::fs::write(path, data)?;
        Ok(())
    }
}
