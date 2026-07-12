//! 通用 HTTP 代理，通过 NAPI 暴露给主进程。
//! 用于渲染进程无法直接请求（CORS）的外部 API。

use std::collections::HashMap;
use tracing::debug;

/// HTTP 响应
pub struct ProxyResponse {
    pub status: u16,
    pub body: String,
    pub headers: Vec<(String, String)>,
}

/// 同步 HTTP GET（在调用方的 spawn_blocking 线程中执行）
pub fn do_get(url: &str, headers: &HashMap<String, String>) -> Result<ProxyResponse, String> {
    let agent = ureq::Agent::new();
    let mut req = agent.get(url);
    for (key, value) in headers {
        req = req.set(key, value);
    }
    debug!(url_len = url.len(), "HTTP 代理 GET");
    send(req)
}

/// 同步 HTTP POST（application/x-www-form-urlencoded）
pub fn do_post(
    url: &str,
    headers: &HashMap<String, String>,
    body: &str,
) -> Result<ProxyResponse, String> {
    let agent = ureq::Agent::new();
    let mut req = agent.post(url);
    for (key, value) in headers {
        req = req.set(key, value);
    }
    debug!(url_len = url.len(), "HTTP 代理 POST");
    let resp = req
        .send_string(body)
        .map_err(|e| format!("请求失败: {e}"))?;
    read_response(resp)
}

fn send(req: ureq::Request) -> Result<ProxyResponse, String> {
    let resp = req.call().map_err(|e| format!("请求失败: {e}"))?;
    read_response(resp)
}

fn read_response(resp: ureq::Response) -> Result<ProxyResponse, String> {
    let status = resp.status();
    let mut resp_headers = Vec::new();
    for name in resp.headers_names() {
        if let Some(value) = resp.header(&name) {
            resp_headers.push((name, value.to_string()));
        }
    }
    let body = resp
        .into_string()
        .map_err(|e| format!("读取响应失败: {e}"))?;
    Ok(ProxyResponse {
        status,
        body,
        headers: resp_headers,
    })
}
