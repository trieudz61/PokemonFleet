//! HTTP client wrapping the IOSControl REST API on each device.
//!
//! All endpoints called here are documented in
//! `IOSControl/src/HTTPServer.m`. The base URL is always
//! `http://127.0.0.1:<port>` where `<port>` was allocated by the tunnel pool.

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Clone)]
pub struct ApiClient {
    http: Client,
}

impl ApiClient {
    pub fn new() -> Self {
        // Long timeout for /api/scripts/upload (multi-MB .lue files).
        // Per-call overrides are still possible.
        let http = Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(30))
            .pool_idle_timeout(Duration::from_secs(60))
            .build()
            .expect("reqwest client build");
        Self { http }
    }

    fn url(port: u16, path: &str) -> String {
        format!("http://127.0.0.1:{}{}", port, path)
    }

    // ── Health & info ──────────────────────────────────────────────────

    pub async fn ping(&self, port: u16) -> Result<Value> {
        let r = self.http.get(Self::url(port, "/ping"))
            .timeout(Duration::from_secs(2))
            .send().await?;
        Ok(r.json::<Value>().await?)
    }

    pub async fn device_info(&self, port: u16) -> Result<DeviceInfoResp> {
        let r = self.http.get(Self::url(port, "/api/device/info"))
            .timeout(Duration::from_secs(3))
            .send().await?;
        if !r.status().is_success() {
            return Err(anyhow!("/api/device/info HTTP {}", r.status()));
        }
        Ok(r.json::<DeviceInfoResp>().await?)
    }

    pub async fn license_status(&self, port: u16) -> Result<Value> {
        let r = self.http.get(Self::url(port, "/api/license"))
            .send().await?;
        Ok(r.json::<Value>().await?)
    }

    // ── Script lifecycle ───────────────────────────────────────────────

    pub async fn run_script(&self, port: u16, script_name: &str) -> Result<RunResp> {
        let body = json!({ "scriptName": script_name });
        let r = self.http.post(Self::url(port, "/api/scripts/run"))
            .json(&body)
            .send().await?;
        Ok(r.json::<RunResp>().await
            .with_context(|| format!("decode run response for {}", script_name))?)
    }

    /// Run an ad-hoc Lua snippet. The device-side server uses `scriptName`
    /// purely as a display label when `code` is provided.
    pub async fn run_script_with_code(&self, port: u16, label: &str, code: &str) -> Result<RunResp> {
        let body = json!({ "scriptName": label, "code": code });
        let r = self.http.post(Self::url(port, "/api/scripts/run"))
            .json(&body)
            .send().await?;
        Ok(r.json::<RunResp>().await
            .with_context(|| format!("decode run response for {}", label))?)
    }

    pub async fn stop_script(&self, port: u16) -> Result<Value> {
        let r = self.http.post(Self::url(port, "/api/scripts/stop"))
            .send().await?;
        Ok(r.json::<Value>().await?)
    }

    pub async fn running_status(&self, port: u16) -> Result<RunningResp> {
        let r = self.http.get(Self::url(port, "/api/scripts/running"))
            .send().await?;
        Ok(r.json::<RunningResp>().await?)
    }

    // ── File operations ────────────────────────────────────────────────

    pub async fn list_files(&self, port: u16) -> Result<Value> {
        let r = self.http.get(Self::url(port, "/api/scripts/files"))
            .send().await?;
        Ok(r.json::<Value>().await?)
    }

    pub async fn download_file(&self, port: u16, name: &str) -> Result<Vec<u8>> {
        let r = self.http.get(Self::url(port, "/api/scripts/download"))
            .query(&[("name", name)])
            .send().await?;
        if !r.status().is_success() {
            return Err(anyhow!("download {} -> HTTP {}", name, r.status()));
        }
        Ok(r.bytes().await?.to_vec())
    }

    /// Save a TEXT script (.lua / .txt). For .lue use upload_binary.
    pub async fn save_text(&self, port: u16, name: &str, code: &str) -> Result<Value> {
        let body = json!({ "name": name, "code": code });
        let r = self.http.post(Self::url(port, "/api/scripts/save"))
            .json(&body)
            .send().await?;
        Ok(r.json::<Value>().await?)
    }

    pub async fn upload_binary(&self, port: u16, name: &str, data: &[u8]) -> Result<Value> {
        let body = json!({
            "name": name,
            "data": B64.encode(data),
        });
        let r = self.http.post(Self::url(port, "/api/scripts/upload"))
            .json(&body)
            .timeout(Duration::from_secs(60))
            .send().await?;
        Ok(r.json::<Value>().await?)
    }

    pub async fn delete_file(&self, port: u16, name: &str) -> Result<Value> {
        let body = json!({ "name": name });
        let r = self.http.post(Self::url(port, "/api/scripts/delete"))
            .json(&body)
            .send().await?;
        Ok(r.json::<Value>().await?)
    }
}

// ─────────────────────────── Response types ──────────────────────────────

/// Subset of `/api/device/info` we care about; extra keys are ignored.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DeviceInfoResp {
    #[serde(default)] pub udid: String,
    #[serde(default)] pub name: String,
    #[serde(default)] pub model: String,
    #[serde(default, alias = "system_version")] pub ios_version: String,
    #[serde(default)] pub ip: String,
    #[serde(default)] pub ioscontrol_version: String,
    #[serde(default)] pub has_pokemon_loader: bool,
    #[serde(default)] pub license: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RunResp {
    pub success: bool,
    #[serde(default, alias = "taskId")] pub task_id: Option<String>,
    #[serde(default)] pub error: Option<String>,
    #[serde(default)] pub detail: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RunningResp {
    #[serde(default)] pub running: bool,
    #[serde(default, alias = "scriptName")] pub script_name: Option<String>,
    #[serde(default, alias = "taskId")] pub task_id: Option<String>,
}
