import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

const fleetUrl = 'https://fleet.dropxlogistics.com/fleet-control?source=android_app';

void main() => runApp(const DropXFleetApp());

class DropXFleetApp extends StatelessWidget {
  const DropXFleetApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        debugShowCheckedModeBanner: false,
        title: 'DropX Fleet',
        theme: ThemeData(
          colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFFD92D67), brightness: Brightness.light),
          scaffoldBackgroundColor: const Color(0xFFF7F7F8),
          useMaterial3: true,
        ),
        home: const FleetPortal(),
      );
}

class FleetPortal extends StatefulWidget {
  const FleetPortal({super.key});
  @override
  State<FleetPortal> createState() => _FleetPortalState();
}

class _FleetPortalState extends State<FleetPortal> {
  late final WebViewController controller;
  var progress = 0;

  @override
  void initState() {
    super.initState();
    controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xFFF7F7F8))
      ..setNavigationDelegate(NavigationDelegate(
        onProgress: (value) => setState(() => progress = value),
        onNavigationRequest: (request) {
          final uri = Uri.parse(request.url);
          final trusted = uri.host == 'fleet.dropxlogistics.com' || uri.host.endsWith('.dropxlogistics.com') || uri.host.endsWith('google.com') || uri.host.endsWith('googleusercontent.com');
          if (trusted) return NavigationDecision.navigate;
          launchUrl(uri, mode: LaunchMode.externalApplication);
          return NavigationDecision.prevent;
        },
      ))
      ..loadRequest(Uri.parse(fleetUrl));
  }

  Future<bool> handleBack() async {
    if (await controller.canGoBack()) { await controller.goBack(); return false; }
    return true;
  }

  @override
  Widget build(BuildContext context) => PopScope(
        canPop: false,
        onPopInvokedWithResult: (didPop, result) async { if (!didPop && await handleBack() && mounted) Navigator.of(context).pop(); },
        child: Scaffold(
          body: SafeArea(
            child: Stack(children: [
              WebViewWidget(controller: controller),
              if (progress < 100) LinearProgressIndicator(value: progress / 100, minHeight: 2, color: const Color(0xFFD92D67)),
            ]),
          ),
        ),
      );
}
