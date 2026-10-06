import 'dart:convert';

import 'package:anx_reader/page/reading_page.dart';
import 'package:anx_reader/utils/platform_utils.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';

/// O1 方案 B 总开关（回滚点，见 design §6.2）。
///
/// 置 `false` 时 [ReaderMouseGuard] 的 push/refresh/pop 全部退回 no-op，
/// JS 侧完全无状态（连包都不发）→ 整体退化为"只有方案 A"的行为。
const bool kReaderMouseGuardEnabled = true;

/// 一个守卫 owner 占据的区域描述（见 design §5.1）。
class MouseGuardRegion {
  MouseGuardRegion({
    required this.owner,
    this.fullscreen = false,
    this.rect,
    this.token,
  });

  /// owner 标识：`contextMenu` / `bottomBar` / `drawer` / `smartDialog` / ...
  final String owner;

  /// true => `scope: 'all'`（全视口）。
  final bool fullscreen;

  /// 懒取该 owner 当前占据的矩形（屏幕全局坐标）；null 表示尚未测量。
  final Rect? Function()? rect;

  /// owner 实例标识：同一 owner 名被"旧浮层替换为新浮层"时用于区分，
  /// 避免迟到的旧 dispose 误删新注册的区域（见 pop）。
  final Object? token;
}

/// Dart 侧守卫：聚合 owner 区域 → 归一化到 WebView 视口 → 通过
/// `evaluateJavascript` 下发。每个阅读页实例持有独立一份（见 design §5.1/§6.1）。
class ReaderMouseGuard {
  static const double _expandPx = 4; // 矩形外扩（屏幕像素），见 design §3.4 / §11.4

  final Map<String, MouseGuardRegion> _regions = <String, MouseGuardRegion>{};
  InAppWebViewController? _controller;
  int _seq = -1;

  /// WebView 创建/重建后调用：绑定 controller 并重放当前状态（幂等）。
  void attach(InAppWebViewController controller) {
    _controller = controller;
    flush();
  }

  void push(String owner,
      {bool fullscreen = false, Rect? Function()? rect, Object? token}) {
    _regions[owner] = MouseGuardRegion(
      owner: owner,
      fullscreen: fullscreen,
      rect: rect,
      token: token,
    );
    flush();
  }

  /// 区域发生变化（菜单重排 / 键盘弹出 / 子菜单展开）后调用。
  void refresh(String owner) {
    if (_regions.containsKey(owner)) flush();
  }

  /// 移除 owner 的区域。若传入 [token]，仅当当前注册者的 token 与之一致时才移除
  /// —— 浮层替换时旧实例的 dispose 晚于新实例的 initState（Flutter 在 build 阶段
  /// 挂载新子树、在 finalizeTree 阶段卸载旧子树），必须避免旧 dispose 误删新区域。
  void pop(String owner, {Object? token}) {
    final existing = _regions[owner];
    if (existing == null) return;
    if (token != null && !identical(existing.token, token)) return;
    _regions.remove(owner);
    flush();
  }

  /// 阅读页销毁：清空所有 owner 与 controller（无需发包）。
  void reset() {
    _regions.clear();
    _controller = null;
    _seq = -1;
  }

  /// 幂等的"全量重放"：聚合当前所有 owner → 下发。
  void flush() {
    final controller = _controller;
    if (controller == null) return;
    if (!kReaderMouseGuardEnabled || !AnxPlatform.isAndroid) return;

    final box = epubPlayerKey.currentContext?.findRenderObject() as RenderBox?;

    var fullscreen = false;
    final rects = <List<double>>[];
    final sources = <String>[];

    if (box != null && box.hasSize) {
      // 用 box 的屏幕四角归一化，天然包含 FittedBox 等缩放（见 design §5.4）。
      final origin = box.localToGlobal(Offset.zero);
      final far = box.localToGlobal(Offset(box.size.width, box.size.height));
      final width = far.dx - origin.dx;
      final height = far.dy - origin.dy;
      if (width > 0 && height > 0) {
        final padX = _expandPx / width;
        final padY = _expandPx / height;
        for (final region in _regions.values) {
          sources.add(region.owner);
          if (region.fullscreen) {
            fullscreen = true;
            continue;
          }
          final rect = region.rect?.call();
          if (rect == null) continue;
          final left = (((rect.left - origin.dx) / width) - padX).clamp(0.0, 1.0).toDouble();
          final top = (((rect.top - origin.dy) / height) - padY).clamp(0.0, 1.0).toDouble();
          final right = (((rect.right - origin.dx) / width) + padX).clamp(0.0, 1.0).toDouble();
          final bottom = (((rect.bottom - origin.dy) / height) + padY).clamp(0.0, 1.0).toDouble();
          if (right <= left || bottom <= top) continue;
          rects.add(<double>[left, top, right, bottom]);
        }
      }
    }

    final scope = fullscreen ? 'all' : 'rects';
    final active = fullscreen || rects.isNotEmpty;

    _seq += 1;
    final payload = <String, dynamic>{
      'v': 1,
      'seq': _seq,
      'active': active,
      'scope': scope,
      'rects': rects,
      'sources': sources,
    };

    controller.evaluateJavascript(
      source:
          'window.__anxSetMouseGuard && window.__anxSetMouseGuard(${jsonEncode(payload)});',
    );
  }
}
