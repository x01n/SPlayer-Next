use napi::bindgen_prelude::*;
use napi_derive::napi;
use x11rb::connection::Connection;
use x11rb::protocol::shape::ConnectionExt as ShapeConnectionExt;
use x11rb::protocol::xproto::{
  ClientMessageData, ClientMessageEvent, ConnectionExt as _, EventMask,
  CLIENT_MESSAGE_EVENT,
};
use x11rb::rust_connection::RustConnection;

/** shape 操作常量 */
use x11rb::protocol::shape::{SO, SK};

/** 尝试连接 X11 服务器 */
fn connect_x11() -> napi::Result<(RustConnection, usize)> {
  RustConnection::connect(None)
    .map_err(|e| Error::from_reason(format!("X11 连接失败: {}", e)))
}

/** 获取 X11 atom */
fn intern_atom(conn: &RustConnection, name: &[u8]) -> napi::Result<u32> {
  conn
    .intern_atom(false, name)
    .map_err(|e| Error::from_reason(format!("InternAtom 失败: {}", e)))?
    .reply()
    .map_err(|e| Error::from_reason(format!("InternAtom reply 失败: {}", e)))
    .map(|r| r.atom)
}

/**
 * 通过 X11 _NET_WM_STATE 设置窗口置顶/取消置顶
 * @param window_id - X11 Window ID（Electron getNativeWindowHandle() 返回值）
 * @param enable - true 设置置顶，false 取消置顶
 */
#[napi]
pub fn set_always_on_top_x11(window_id: i64, enable: bool) -> napi::Result<()> {
  let (conn, screen_num) = connect_x11()?;
  let screen = &conn.setup().roots[screen_num];

  let net_wm_state = intern_atom(&conn, b"_NET_WM_STATE")?;
  let net_wm_state_above = intern_atom(&conn, b"_NET_WM_STATE_ABOVE")?;
  let wid = window_id as u32;

  // 通过 ClientMessage 通知窗口管理器，这是 EWMH 标准做法
  let data: [u32; 5] = if enable {
    [1, net_wm_state_above, 0, 0, 0]
  } else {
    [0, net_wm_state_above, 0, 0, 0]
  };

  let event = ClientMessageEvent {
    response_type: CLIENT_MESSAGE_EVENT,
    format: 32,
    sequence: 0,
    window: wid,
    type_: net_wm_state,
    data: ClientMessageData::from(data),
  };

  conn
    .send_event(
      false,
      screen.root,
      EventMask::SUBSTRUCTURE_NOTIFY | EventMask::SUBSTRUCTURE_REDIRECT,
      event,
    )
    .map_err(|e| Error::from_reason(format!("SendEvent 失败: {}", e)))?;

  conn
    .flush()
    .map_err(|e| Error::from_reason(format!("Flush 失败: {}", e)))?;

  Ok(())
}

/**
 * 通过 X11 Shape 扩展设置鼠标事件穿透/恢复
 * Electron 的 setIgnoreMouseEvents 在 Linux transparent 窗口上可能不生效，
 * 通过 XShape ShapeInput 直接设置输入区域为空来绕过
 * @param window_id - X11 Window ID
 * @param ignore - true 忽略鼠标事件（穿透），false 恢复
 */
#[napi]
pub fn set_ignore_mouse_events_x11(window_id: i64, ignore: bool) -> napi::Result<()> {
  let (conn, _screen_num) = connect_x11()?;
  let wid = window_id as u32;

  if ignore {
    // 输入区域设为空，窗口不接收任何鼠标事件
    conn
      .shape_rectangles(
        SO::SET,
        SK::INPUT,
        x11rb::protocol::xproto::ClipOrdering::YX_BANDED,
        wid,
        0,
        0,
        &[],
      )
      .map_err(|e| Error::from_reason(format!("ShapeRectangles 失败: {}", e)))?;
  } else {
    // 恢复输入区域为整个窗口（覆盖最大范围）
    conn
      .shape_rectangles(
        SO::SET,
        SK::INPUT,
        x11rb::protocol::xproto::ClipOrdering::YX_BANDED,
        wid,
        0,
        0,
        &[x11rb::protocol::xproto::Rectangle {
          x: 0,
          y: 0,
          width: 32767,
          height: 32767,
        }],
      )
      .map_err(|e| Error::from_reason(format!("ShapeRectangles 失败: {}", e)))?;
  }

  conn
    .flush()
    .map_err(|e| Error::from_reason(format!("Flush 失败: {}", e)))?;

  Ok(())
}

/**
 * 检测当前是否在 Wayland 环境下运行
 * @returns true 表示检测到 Wayland
 */
#[napi]
pub fn is_wayland() -> bool {
  std::env::var("WAYLAND_DISPLAY").is_ok() || std::env::var("WAYLAND_SOCKET").is_ok()
}

/**
 * 检测当前是否在 X11 环境下运行
 * @returns true 表示检测到 X11
 */
#[napi]
pub fn is_x11() -> bool {
  std::env::var("DISPLAY").is_ok() && !is_wayland()
}
