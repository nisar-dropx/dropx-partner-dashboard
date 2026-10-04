import 'dart:convert';

import 'package:cookie_jar/cookie_jar.dart';
import 'package:dio/dio.dart';
import 'package:dio_cookie_manager/dio_cookie_manager.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

const apiOrigin = 'https://fleet.dropxlogistics.com';
const supabaseUrl = String.fromEnvironment('SUPABASE_URL');
const supabaseAnonKey = String.fromEnvironment('SUPABASE_ANON_KEY');
const brand = Color(0xffd92d67);
const ink = Color(0xff121b31);
const canvas = Color(0xfff5f6f8);

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  if (supabaseUrl.isNotEmpty && supabaseAnonKey.isNotEmpty) {
    await Supabase.initialize(
      url: supabaseUrl,
      publishableKey: supabaseAnonKey,
      authOptions:
          const FlutterAuthClientOptions(authFlowType: AuthFlowType.pkce),
    );
  }
  runApp(DropXFleetApp(api: await FleetApi.create()));
}

class DropXFleetApp extends StatelessWidget {
  const DropXFleetApp({super.key, required this.api});
  final FleetApi api;

  @override
  Widget build(BuildContext context) => MaterialApp(
        debugShowCheckedModeBanner: false,
        title: 'DropX Fleet',
        theme: ThemeData(
          colorScheme: ColorScheme.fromSeed(seedColor: brand),
          scaffoldBackgroundColor: canvas,
          useMaterial3: true,
          appBarTheme: const AppBarTheme(
              backgroundColor: Colors.white,
              foregroundColor: ink,
              surfaceTintColor: Colors.transparent),
          cardTheme: const CardThemeData(
              color: Colors.white, elevation: 0, margin: EdgeInsets.zero),
          inputDecorationTheme: InputDecorationTheme(
            filled: true,
            fillColor: Colors.white,
            border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(14),
                borderSide: const BorderSide(color: Color(0xffdfe3e8))),
            enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(14),
                borderSide: const BorderSide(color: Color(0xffdfe3e8))),
          ),
        ),
        home: supabaseUrl.isEmpty || supabaseAnonKey.isEmpty
            ? const MissingConfiguration()
            : FleetSessionGate(api: api),
      );
}

class MissingConfiguration extends StatelessWidget {
  const MissingConfiguration({super.key});
  @override
  Widget build(BuildContext context) => const Scaffold(
        body: SafeArea(
          child: Center(
            child: Padding(
              padding: EdgeInsets.all(28),
              child: Text(
                  'This Fleet build is missing its secure login configuration. Install the official APK from fleet.dropxlogistics.com.'),
            ),
          ),
        ),
      );
}

class FleetSessionGate extends StatefulWidget {
  const FleetSessionGate({super.key, required this.api});
  final FleetApi api;
  @override
  State<FleetSessionGate> createState() => _FleetSessionGateState();
}

class _FleetSessionGateState extends State<FleetSessionGate> {
  Session? session = Supabase.instance.client.auth.currentSession;
  bool authenticatedWithWhatsApp = false;
  bool checkingSession = true;

  @override
  void initState() {
    super.initState();
    Supabase.instance.client.auth.onAuthStateChange.listen((event) {
      if (!mounted) return;
      setState(() => session = event.session);
      if (event.session != null) _exchange(event.session!);
    });
    _restoreSession();
  }

  Future<void> _restoreSession() async {
    if (session != null) {
      await _exchange(session!);
      return;
    }
    final active = await widget.api.hasSession();
    if (mounted) {
      setState(() {
        authenticatedWithWhatsApp = active;
        checkingSession = false;
      });
    }
  }

  Future<void> _exchange(Session active) async {
    if (mounted) setState(() => checkingSession = true);
    try {
      await widget.api.exchangeSession(active);
    } finally {
      if (mounted) setState(() => checkingSession = false);
    }
  }

  Future<void> _logout() async {
    await widget.api.logout();
    await Supabase.instance.client.auth.signOut();
    if (mounted) {
      setState(() {
        session = null;
        authenticatedWithWhatsApp = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (checkingSession)
      return const BrandedLoader(label: 'Opening your Fleet workspace…');
    if (session == null && !authenticatedWithWhatsApp) {
      return FleetLogin(
        api: widget.api,
        onAuthenticated: () => setState(() => authenticatedWithWhatsApp = true),
      );
    }
    return FleetHome(api: widget.api, onLogout: _logout);
  }
}

class FleetLogin extends StatefulWidget {
  const FleetLogin(
      {super.key, required this.api, required this.onAuthenticated});
  final FleetApi api;
  final VoidCallback onAuthenticated;
  @override
  State<FleetLogin> createState() => _FleetLoginState();
}

class _FleetLoginState extends State<FleetLogin> {
  final mobile = TextEditingController();
  final otp = TextEditingController();
  String countryCode = '91';
  bool otpSent = false;
  bool busy = false;
  String? message;

  Future<void> google() async {
    setState(() {
      busy = true;
      message = null;
    });
    try {
      await Supabase.instance.client.auth.signInWithOAuth(
        OAuthProvider.google,
        redirectTo: 'com.dropxlogistics.fleet://login-callback',
        authScreenLaunchMode: LaunchMode.externalApplication,
        queryParams: {'prompt': 'select_account'},
      );
    } catch (error) {
      setState(() => message = readableError(error));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> sendOtp() async {
    if (mobile.text.replaceAll(RegExp(r'\D'), '').length < 8) {
      setState(() => message = 'Enter a valid registered mobile number.');
      return;
    }
    setState(() {
      busy = true;
      message = null;
    });
    try {
      await widget.api.sendWhatsAppOtp(mobile.text, countryCode);
      setState(() {
        otpSent = true;
        message = 'OTP sent to your WhatsApp.';
      });
    } catch (error) {
      setState(() => message = readableError(error));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> verify() async {
    if (otp.text.length != 6) {
      setState(() => message = 'Enter the 6 digit OTP.');
      return;
    }
    setState(() {
      busy = true;
      message = null;
    });
    try {
      await widget.api.verifyWhatsAppOtp(mobile.text, countryCode, otp.text);
      widget.onAuthenticated();
    } catch (error) {
      setState(() => message = readableError(error));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        body: SafeArea(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(24, 40, 24, 28),
            children: [
              Row(children: [
                Container(
                    width: 52,
                    height: 52,
                    decoration: BoxDecoration(
                        color: ink, borderRadius: BorderRadius.circular(16)),
                    child:
                        const Icon(Icons.route_rounded, color: Colors.white)),
                const SizedBox(width: 13),
                const Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('DropX',
                          style: TextStyle(
                              fontWeight: FontWeight.w800, fontSize: 17)),
                      Text('FLEET',
                          style: TextStyle(
                              color: brand,
                              fontWeight: FontWeight.w800,
                              letterSpacing: 2))
                    ]),
              ]),
              const SizedBox(height: 45),
              const Text('Fleet operations,\nin your pocket.',
                  style: TextStyle(
                      fontSize: 35,
                      height: 1.05,
                      fontWeight: FontWeight.w900,
                      color: ink)),
              const SizedBox(height: 12),
              const Text(
                  'Vehicles, audits, documents, service and approvals in one fast mobile workspace.',
                  style: TextStyle(
                      fontSize: 16, height: 1.45, color: Color(0xff657087))),
              const SizedBox(height: 30),
              FilledButton.icon(
                  onPressed: busy ? null : google,
                  icon: const Icon(Icons.g_mobiledata_rounded, size: 28),
                  label: const Text('Continue with Google'),
                  style: FilledButton.styleFrom(
                      minimumSize: const Size.fromHeight(54),
                      backgroundColor: ink,
                      shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(15)))),
              const Padding(
                  padding: EdgeInsets.symmetric(vertical: 22),
                  child: Row(children: [
                    Expanded(child: Divider()),
                    Padding(
                        padding: EdgeInsets.symmetric(horizontal: 12),
                        child: Text('or use WhatsApp',
                            style: TextStyle(color: Color(0xff7b8495)))),
                    Expanded(child: Divider())
                  ])),
              Row(children: [
                SizedBox(
                    width: 88,
                    child: DropdownButtonFormField<String>(
                        value: countryCode,
                        items: const [
                          DropdownMenuItem(value: '91', child: Text('+91')),
                          DropdownMenuItem(value: '971', child: Text('+971'))
                        ],
                        onChanged: otpSent
                            ? null
                            : (value) =>
                                setState(() => countryCode = value ?? '91'))),
                const SizedBox(width: 10),
                Expanded(
                    child: TextField(
                        controller: mobile,
                        enabled: !otpSent,
                        keyboardType: TextInputType.phone,
                        decoration: const InputDecoration(
                            labelText: 'Registered mobile'))),
              ]),
              const SizedBox(height: 12),
              if (!otpSent)
                OutlinedButton.icon(
                    onPressed: busy ? null : sendOtp,
                    icon: const Icon(Icons.chat_outlined),
                    label: const Text('Continue with WhatsApp OTP'),
                    style: OutlinedButton.styleFrom(
                        minimumSize: const Size.fromHeight(52),
                        foregroundColor: const Color(0xff087f5b))),
              if (otpSent) ...[
                TextField(
                    controller: otp,
                    keyboardType: TextInputType.number,
                    maxLength: 6,
                    decoration: const InputDecoration(
                        labelText: '6 digit OTP', counterText: '')),
                const SizedBox(height: 12),
                FilledButton(
                    onPressed: busy ? null : verify,
                    style: FilledButton.styleFrom(
                        minimumSize: const Size.fromHeight(52),
                        backgroundColor: brand),
                    child: Text(busy ? 'Verifying…' : 'Verify and sign in')),
                TextButton(
                    onPressed: busy
                        ? null
                        : () => setState(() {
                              otpSent = false;
                              otp.clear();
                              message = null;
                            }),
                    child: const Text('Change mobile number')),
              ],
              if (message != null)
                Container(
                    margin: const EdgeInsets.only(top: 14),
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                        color: const Color(0xfffff3f6),
                        borderRadius: BorderRadius.circular(12)),
                    child: Text(message!,
                        style: const TextStyle(color: Color(0xff9f164b)))),
              if (busy)
                const Padding(
                    padding: EdgeInsets.only(top: 14),
                    child: LinearProgressIndicator(color: brand)),
              const SizedBox(height: 28),
              const Text('Only active users enabled for Fleet can sign in.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Color(0xff7b8495), fontSize: 12)),
            ],
          ),
        ),
      );
}

class FleetHome extends StatefulWidget {
  const FleetHome({super.key, required this.api, required this.onLogout});
  final FleetApi api;
  final Future<void> Function() onLogout;
  @override
  State<FleetHome> createState() => _FleetHomeState();
}

class _FleetHomeState extends State<FleetHome> {
  int index = 0;
  FleetSnapshot? snapshot;
  String? error;
  bool loading = true;

  @override
  void initState() {
    super.initState();
    refresh();
  }

  Future<void> refresh() async {
    setState(() {
      loading = true;
      error = null;
    });
    try {
      final value = await widget.api.snapshot();
      if (mounted) setState(() => snapshot = value);
    } catch (caught) {
      if (mounted) setState(() => error = readableError(caught));
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (snapshot == null && loading)
      return const BrandedLoader(label: 'Loading live Fleet data…');
    if (snapshot == null)
      return ErrorView(
          message: error ?? 'Unable to load Fleet.',
          retry: refresh,
          logout: logout);
    final pages = [
      TodayScreen(snapshot: snapshot!, refresh: refresh),
      VehiclesScreen(api: widget.api, snapshot: snapshot!, refresh: refresh),
      AuditsScreen(api: widget.api, snapshot: snapshot!, refresh: refresh),
      PaymentsScreen(api: widget.api, snapshot: snapshot!, refresh: refresh),
      MoreScreen(snapshot: snapshot!, refresh: refresh, logout: logout),
    ];
    return Scaffold(
      appBar: AppBar(
        toolbarHeight: 48,
        titleSpacing: 18,
        title: const Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(Icons.local_shipping_rounded, color: brand, size: 21),
          SizedBox(width: 8),
          Text('DropX Fleet',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.w900))
        ]),
        actions: [
          IconButton(
              tooltip: 'Sign out',
              onPressed: logout,
              icon: const Icon(Icons.logout_rounded, color: Color(0xffb52c58))),
          const SizedBox(width: 6)
        ],
      ),
      body: SafeArea(child: IndexedStack(index: index, children: pages)),
      bottomNavigationBar: NavigationBar(
        selectedIndex: index,
        onDestinationSelected: (value) => setState(() => index = value),
        destinations: const [
          NavigationDestination(
              icon: Icon(Icons.dashboard_outlined),
              selectedIcon: Icon(Icons.dashboard_rounded),
              label: 'Today'),
          NavigationDestination(
              icon: Icon(Icons.local_shipping_outlined),
              selectedIcon: Icon(Icons.local_shipping_rounded),
              label: 'Vehicles'),
          NavigationDestination(
              icon: Icon(Icons.fact_check_outlined),
              selectedIcon: Icon(Icons.fact_check_rounded),
              label: 'Audits'),
          NavigationDestination(
              icon: Icon(Icons.approval_outlined),
              selectedIcon: Icon(Icons.approval_rounded),
              label: 'Approvals'),
          NavigationDestination(
              icon: Icon(Icons.grid_view_outlined),
              selectedIcon: Icon(Icons.grid_view_rounded),
              label: 'More'),
        ],
      ),
    );
  }

  Future<void> logout() async {
    await widget.onLogout();
  }
}

class TodayScreen extends StatelessWidget {
  const TodayScreen({super.key, required this.snapshot, required this.refresh});
  final FleetSnapshot snapshot;
  final Future<void> Function() refresh;
  @override
  Widget build(BuildContext context) {
    final counts = snapshot.map('counts');
    final vehicles = snapshot.list('vehicles');
    final unavailable = vehicles
        .where((item) => text(item['status']) != 'active')
        .take(5)
        .toList();
    return RefreshIndicator(
      onRefresh: refresh,
      child: ListView(
          padding: const EdgeInsets.fromLTRB(18, 18, 18, 28),
          children: [
            PageHeader(
                eyebrow: 'LIVE FLEET',
                title: greeting(),
                subtitle: snapshot.userName,
                trailing: IconButton(
                    onPressed: refresh,
                    icon: const Icon(Icons.refresh_rounded))),
            const SizedBox(height: 18),
            LayoutBuilder(
                builder: (context, constraints) => GridView.count(
                        shrinkWrap: true,
                        physics: const NeverScrollableScrollPhysics(),
                        crossAxisCount: constraints.maxWidth < 330 ? 1 : 2,
                        childAspectRatio:
                            constraints.maxWidth < 330 ? 2.9 : 1.55,
                        mainAxisSpacing: 10,
                        crossAxisSpacing: 10,
                        children: [
                          MetricCard(
                              label: 'Vehicles',
                              value: '${counts['vehicles'] ?? 0}',
                              tone: ink,
                              icon: Icons.local_shipping_outlined),
                          MetricCard(
                              label: 'Operational',
                              value: '${counts['active'] ?? 0}',
                              tone: const Color(0xff087f5b),
                              icon: Icons.check_circle_outline),
                          MetricCard(
                              label: 'Unavailable',
                              value: '${counts['unavailable'] ?? 0}',
                              tone: const Color(0xffc92a2a),
                              icon: Icons.warning_amber_rounded),
                          MetricCard(
                              label: 'Approvals',
                              value: '${counts['pendingPayments'] ?? 0}',
                              tone: const Color(0xff8c5b00),
                              icon: Icons.approval_outlined),
                        ])),
            const SizedBox(height: 20),
            SectionTitle(
                title: 'Needs attention',
                caption: unavailable.isEmpty
                    ? 'Everything is operational'
                    : '${unavailable.length} priority vehicles'),
            const SizedBox(height: 10),
            if (unavailable.isEmpty)
              const EmptyCard(
                  icon: Icons.verified_rounded,
                  title: 'Fleet is ready',
                  message: 'No unavailable vehicle in your current scope.'),
            ...unavailable.map((vehicle) => VehicleTile(vehicle: vehicle)),
            const SizedBox(height: 20),
            const SectionTitle(title: 'Today at a glance'),
            const SizedBox(height: 10),
            Card(
                child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(children: [
                      SummaryRow(
                          icon: Icons.assignment_late_outlined,
                          label: 'Audits due',
                          value: '${counts['auditsDue'] ?? 0}'),
                      const Divider(height: 24),
                      SummaryRow(
                          icon: Icons.build_outlined,
                          label: 'Services due',
                          value: '${counts['serviceDue'] ?? 0}'),
                      const Divider(height: 24),
                      SummaryRow(
                          icon: Icons.bolt_outlined,
                          label: 'Ad Hoc requests',
                          value: '${counts['adHocToday'] ?? 0}'),
                      const Divider(height: 24),
                      SummaryRow(
                          icon: Icons.description_outlined,
                          label: 'Document attention',
                          value: '${counts['documentAttention'] ?? 0}'),
                    ]))),
          ]),
    );
  }
}

class VehiclesScreen extends StatefulWidget {
  const VehiclesScreen(
      {super.key,
      required this.api,
      required this.snapshot,
      required this.refresh});
  final FleetApi api;
  final FleetSnapshot snapshot;
  final Future<void> Function() refresh;
  @override
  State<VehiclesScreen> createState() => _VehiclesScreenState();
}

class _VehiclesScreenState extends State<VehiclesScreen> {
  String query = '';
  String station = 'All';
  @override
  Widget build(BuildContext context) {
    final all = widget.snapshot.list('vehicles');
    final stationValues = {for (final item in all) text(item['stationCode'])}
        .where((value) => value.isNotEmpty)
        .toList()
      ..sort();
    final stations = ['All', ...stationValues];
    final filtered = all.where((vehicle) {
      final matchesQuery =
          '${vehicle['vehicleNo']} ${vehicle['model']} ${vehicle['stationCode']}'
              .toLowerCase()
              .contains(query.toLowerCase());
      return matchesQuery &&
          (station == 'All' || text(vehicle['stationCode']) == station);
    }).toList();
    return RefreshIndicator(
        onRefresh: widget.refresh,
        child: ListView(
            padding: const EdgeInsets.fromLTRB(18, 18, 18, 28),
            children: [
              PageHeader(
                  eyebrow: 'FLEET REGISTRY',
                  title: 'Vehicles',
                  subtitle: '${filtered.length} in current view'),
              const SizedBox(height: 16),
              TextField(
                  onChanged: (value) => setState(() => query = value),
                  decoration: const InputDecoration(
                      prefixIcon: Icon(Icons.search),
                      hintText: 'Search vehicle or model')),
              const SizedBox(height: 10),
              SizedBox(
                  height: 44,
                  child: ListView.separated(
                      scrollDirection: Axis.horizontal,
                      itemCount: stations.length,
                      separatorBuilder: (_, __) => const SizedBox(width: 7),
                      itemBuilder: (_, i) => ChoiceChip(
                          label: Text(stations[i]),
                          selected: station == stations[i],
                          onSelected: (_) =>
                              setState(() => station = stations[i])))),
              const SizedBox(height: 12),
              ...filtered.map((vehicle) => InkWell(
                  onTap: () => showVehicleEditor(context, widget.api,
                      widget.snapshot, vehicle, widget.refresh),
                  borderRadius: BorderRadius.circular(16),
                  child: VehicleTile(vehicle: vehicle, showLocation: true))),
              if (filtered.isEmpty)
                const EmptyCard(
                    icon: Icons.search_off_rounded,
                    title: 'No vehicle found',
                    message: 'Change the search or station filter.'),
            ]));
  }
}

class AuditsScreen extends StatelessWidget {
  const AuditsScreen(
      {super.key,
      required this.api,
      required this.snapshot,
      required this.refresh});
  final FleetApi api;
  final FleetSnapshot snapshot;
  final Future<void> Function() refresh;
  @override
  Widget build(BuildContext context) {
    final audits = snapshot.list('audits')
      ..sort(
          (a, b) => text(a['scheduledFor']).compareTo(text(b['scheduledFor'])));
    final open = audits
        .where((item) =>
            ['scheduled', 'in_progress'].contains(text(item['status'])))
        .toList();
    return RefreshIndicator(
        onRefresh: refresh,
        child: ListView(
            padding: const EdgeInsets.fromLTRB(18, 18, 18, 28),
            children: [
              PageHeader(
                  eyebrow: 'TWICE-MONTHLY PROGRAMME',
                  title: 'Vehicle audits',
                  subtitle: '${open.length} open audit actions'),
              const SizedBox(height: 16),
              if (open.isEmpty)
                const EmptyCard(
                    icon: Icons.fact_check_rounded,
                    title: 'No open audits',
                    message: 'Scheduled and in-progress audits appear here.'),
              ...open.map((audit) => Card(
                  margin: const EdgeInsets.only(bottom: 10),
                  child: InkWell(
                      onTap: () =>
                          showAuditActions(context, api, audit, refresh),
                      borderRadius: BorderRadius.circular(12),
                      child: Padding(
                          padding: const EdgeInsets.all(15),
                          child: Row(children: [
                            StatusIcon(
                                status: text(audit['status']),
                                icon: text(audit['auditMode']) == 'video'
                                    ? Icons.videocam_outlined
                                    : Icons.directions_car_filled_outlined),
                            const SizedBox(width: 12),
                            Expanded(
                                child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                  Text(text(audit['vehicleNo']),
                                      style: const TextStyle(
                                          fontWeight: FontWeight.w800,
                                          fontSize: 16)),
                                  const SizedBox(height: 3),
                                  Text(
                                      '${titleCase(text(audit['auditMode']))} · ${text(audit['stationCode'])}',
                                      style: const TextStyle(
                                          color: Color(0xff687386))),
                                  const SizedBox(height: 5),
                                  Text(formatDate(text(audit['scheduledFor'])),
                                      style: const TextStyle(
                                          fontWeight: FontWeight.w700))
                                ])),
                            StatusPill(status: text(audit['status'])),
                          ]))))),
            ]));
  }
}

class PaymentsScreen extends StatelessWidget {
  const PaymentsScreen(
      {super.key,
      required this.api,
      required this.snapshot,
      required this.refresh});
  final FleetApi api;
  final FleetSnapshot snapshot;
  final Future<void> Function() refresh;
  @override
  Widget build(BuildContext context) {
    final rows = snapshot.list('payments');
    return RefreshIndicator(
        onRefresh: refresh,
        child: ListView(
            padding: const EdgeInsets.fromLTRB(18, 18, 18, 28),
            children: [
              PageHeader(
                  eyebrow: 'ACTION QUEUE',
                  title: 'Approvals',
                  subtitle:
                      '${rows.where((item) => item['canApprove'] == true).length} awaiting your action'),
              const SizedBox(height: 16),
              if (rows.isEmpty)
                const EmptyCard(
                    icon: Icons.done_all_rounded,
                    title: 'Nothing pending',
                    message: 'Vehicle payment requests appear here.'),
              ...rows.map((payment) => Card(
                  margin: const EdgeInsets.only(bottom: 10),
                  child: Padding(
                      padding: const EdgeInsets.all(15),
                      child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(children: [
                              Expanded(
                                  child: Text(
                                      text(payment['requestCode']).isEmpty
                                          ? text(payment['id'])
                                          : text(payment['requestCode']),
                                      style: const TextStyle(
                                          fontWeight: FontWeight.w800,
                                          fontSize: 16))),
                              Text(currency(payment['amount']),
                                  style: const TextStyle(
                                      fontWeight: FontWeight.w900,
                                      fontSize: 17))
                            ]),
                            const SizedBox(height: 5),
                            Text(
                                '${text(payment['stationCode'])} · ${text(payment['paymentHead'])}',
                                style:
                                    const TextStyle(color: Color(0xff687386))),
                            if (text(payment['purpose']).isNotEmpty)
                              Padding(
                                  padding: const EdgeInsets.only(top: 6),
                                  child: Text(text(payment['purpose']))),
                            if (payment['canApprove'] == true)
                              Padding(
                                  padding: const EdgeInsets.only(top: 12),
                                  child: Row(children: [
                                    Expanded(
                                        child: OutlinedButton(
                                            onPressed: () => paymentAction(
                                                context,
                                                api,
                                                payment,
                                                'return',
                                                refresh),
                                            child: const Text('Return'))),
                                    const SizedBox(width: 8),
                                    Expanded(
                                        child: FilledButton(
                                            onPressed: () => paymentAction(
                                                context,
                                                api,
                                                payment,
                                                'approve',
                                                refresh),
                                            style: FilledButton.styleFrom(
                                                backgroundColor:
                                                    const Color(0xff087f5b)),
                                            child: const Text('Approve'))),
                                  ]))
                            else
                              Padding(
                                  padding: const EdgeInsets.only(top: 10),
                                  child: StatusPill(
                                      status: text(payment['status']))),
                          ])))),
            ]));
  }
}

class MoreScreen extends StatelessWidget {
  const MoreScreen(
      {super.key,
      required this.snapshot,
      required this.refresh,
      required this.logout});
  final FleetSnapshot snapshot;
  final Future<void> Function() refresh;
  final Future<void> Function() logout;
  @override
  Widget build(BuildContext context) {
    final modules = <ModuleSpec>[
      ModuleSpec('Documents', Icons.description_outlined,
          const Color(0xff1971c2), 'documents'),
      ModuleSpec('Tracking', Icons.location_on_outlined,
          const Color(0xff0b7285), 'dailyKm'),
      ModuleSpec('Fuel', Icons.local_gas_station_outlined,
          const Color(0xffe67700), 'integrations'),
      ModuleSpec('Service', Icons.build_outlined, const Color(0xff7048e8),
          'serviceHistory'),
      ModuleSpec('Ad Hoc Usage', Icons.bolt_outlined, const Color(0xffd9480f),
          'adHocRows'),
      ModuleSpec('Reports', Icons.bar_chart_rounded, const Color(0xff2b8a3e),
          'reports'),
    ];
    return ListView(
        padding: const EdgeInsets.fromLTRB(18, 18, 18, 28),
        children: [
          PageHeader(
              eyebrow: 'DROPX FLEET',
              title: 'More',
              subtitle: snapshot.userName),
          const SizedBox(height: 18),
          LayoutBuilder(
              builder: (context, constraints) => GridView.builder(
                  shrinkWrap: true,
                  physics: const NeverScrollableScrollPhysics(),
                  gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                      crossAxisCount: constraints.maxWidth < 330 ? 1 : 2,
                      childAspectRatio: constraints.maxWidth < 330 ? 2.8 : 1.25,
                      crossAxisSpacing: 10,
                      mainAxisSpacing: 10),
                  itemCount: modules.length,
                  itemBuilder: (_, index) {
                    final module = modules[index];
                    return Card(
                        child: InkWell(
                            onTap: () => Navigator.of(context).push(
                                MaterialPageRoute(
                                    builder: (_) => ModuleScreen(
                                        spec: module, snapshot: snapshot))),
                            borderRadius: BorderRadius.circular(12),
                            child: Padding(
                                padding: const EdgeInsets.all(15),
                                child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    mainAxisAlignment:
                                        MainAxisAlignment.spaceBetween,
                                    children: [
                                      Container(
                                          width: 42,
                                          height: 42,
                                          decoration: BoxDecoration(
                                              color: module.color
                                                  .withValues(alpha: .11),
                                              borderRadius:
                                                  BorderRadius.circular(12)),
                                          child: Icon(module.icon,
                                              color: module.color)),
                                      Text(module.title,
                                          style: const TextStyle(
                                              fontWeight: FontWeight.w800,
                                              fontSize: 16))
                                    ]))));
                  })),
          const SizedBox(height: 20),
          Card(
              child: Column(children: [
            ListTile(
                leading: const Icon(Icons.sync_rounded),
                title: const Text('Refresh all data'),
                trailing: const Icon(Icons.chevron_right),
                onTap: refresh),
            const Divider(height: 1),
            ListTile(
                leading:
                    const Icon(Icons.logout_rounded, color: Color(0xffc92a2a)),
                title: const Text('Sign out'),
                onTap: logout),
          ])),
          const SizedBox(height: 14),
          Text('DropX Fleet 2.0 · Native Android',
              textAlign: TextAlign.center,
              style: Theme.of(context)
                  .textTheme
                  .bodySmall
                  ?.copyWith(color: const Color(0xff8a93a3))),
        ]);
  }
}

class ModuleScreen extends StatelessWidget {
  const ModuleScreen({super.key, required this.spec, required this.snapshot});
  final ModuleSpec spec;
  final FleetSnapshot snapshot;
  @override
  Widget build(BuildContext context) {
    final rows = spec.key == 'reports'
        ? <Map<String, dynamic>>[]
        : snapshot.list(spec.key);
    return Scaffold(
        appBar: AppBar(title: Text(spec.title)),
        body: ListView(padding: const EdgeInsets.all(18), children: [
          if (spec.key == 'reports')
            const EmptyCard(
                icon: Icons.picture_as_pdf_outlined,
                title: 'Fleet reports',
                message:
                    'Export vehicle, availability, audit, service, kilometre and fuel reports from the Reports workspace.')
          else if (rows.isEmpty)
            EmptyCard(
                icon: spec.icon,
                title: 'No ${spec.title.toLowerCase()} data',
                message: 'Pull to refresh when new data is available.')
          else
            ...rows.take(250).map((row) => moduleTile(spec.key, row)),
        ]));
  }
}

Widget moduleTile(String key, Map<String, dynamic> row) {
  String title;
  String subtitle;
  IconData icon;
  switch (key) {
    case 'documents':
      title =
          '${text(row['vehicleNo'])} · ${titleCase(text(row['documentType']).replaceAll('FLEET_', ''))}';
      subtitle = text(row['expiryDate']).isEmpty
          ? 'No expiry recorded'
          : 'Valid until ${formatDate(text(row['expiryDate']))}';
      icon = Icons.description_outlined;
      break;
    case 'dailyKm':
      title =
          '${text(row['vehicleNo'])} · ${number(row['km']).toStringAsFixed(1)} km';
      subtitle =
          '${formatDate(text(row['date']))} · ${number(row['movingMinutes']).round()} moving minutes · max ${number(row['maxSpeed']).round()} km/h';
      icon = Icons.route_outlined;
      break;
    case 'serviceHistory':
      title = '${text(row['vehicleNo'])} · ${text(row['serviceType'])}';
      subtitle =
          '${formatDate(text(row['serviceDate']))} · ${currency(row['amount'])} · ${titleCase(text(row['status']))}';
      icon = Icons.build_outlined;
      break;
    case 'adHocRows':
      title =
          '${text(row['stationCode'])} · ${titleCase(text(row['requestType']))}';
      subtitle =
          '${formatDate(text(row['date']))} · ${currency(row['amount'])} · ${titleCase(text(row['status']))}';
      icon = Icons.bolt_outlined;
      break;
    default:
      title = text(row['name']).isEmpty ? titleCase(key) : text(row['name']);
      subtitle = text(row['detail']);
      icon = Icons.info_outline;
  }
  return Card(
      margin: const EdgeInsets.only(bottom: 9),
      child: ListTile(
          leading: Icon(icon),
          title:
              Text(title, style: const TextStyle(fontWeight: FontWeight.w700)),
          subtitle: Text(subtitle)));
}

Future<void> showVehicleEditor(
    BuildContext context,
    FleetApi api,
    FleetSnapshot snapshot,
    Map<String, dynamic> vehicle,
    Future<void> Function() refresh) async {
  String status = text(vehicle['status']);
  String deployment = text(vehicle['deploymentStatus']).isEmpty
      ? 'deployed'
      : text(vehicle['deploymentStatus']);
  String locationType = text(vehicle['currentLocationType']).isEmpty
      ? 'station'
      : text(vehicle['currentLocationType']);
  final location = TextEditingController(
      text: text(vehicle['currentLocationLabel']).isEmpty
          ? text(vehicle['stationCode'])
          : text(vehicle['currentLocationLabel']));
  final comment = TextEditingController(text: text(vehicle['statusComment']));
  final statuses = snapshot
      .list('vehicleStatuses')
      .where((item) => item['isActive'] != false)
      .toList();
  await showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (sheetContext) => StatefulBuilder(
          builder: (context, setSheet) => Padding(
              padding: EdgeInsets.fromLTRB(
                  18, 18, 18, MediaQuery.of(context).viewInsets.bottom + 18),
              child: ListView(shrinkWrap: true, children: [
                Row(children: [
                  Expanded(
                      child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                        Text(text(vehicle['vehicleNo']),
                            style: const TextStyle(
                                fontSize: 23, fontWeight: FontWeight.w900)),
                        Text(
                            '${text(vehicle['model'])} · ${text(vehicle['stationCode'])}',
                            style: const TextStyle(color: Color(0xff687386)))
                      ])),
                  IconButton(
                      onPressed: () => Navigator.pop(context),
                      icon: const Icon(Icons.close))
                ]),
                const SizedBox(height: 18),
                DropdownButtonFormField<String>(
                    value: statuses.any((item) => text(item['key']) == status)
                        ? status
                        : null,
                    decoration:
                        const InputDecoration(labelText: 'Availability status'),
                    items: statuses
                        .map((item) => DropdownMenuItem(
                            value: text(item['key']),
                            child: Text(text(item['label']))))
                        .toList(),
                    onChanged: (value) =>
                        setSheet(() => status = value ?? status)),
                const SizedBox(height: 10),
                DropdownButtonFormField<String>(
                    value: deployment,
                    decoration: const InputDecoration(labelText: 'Deployment'),
                    items: const [
                      DropdownMenuItem(
                          value: 'deployed', child: Text('Deployed')),
                      DropdownMenuItem(
                          value: 'not_deployed', child: Text('Not deployed'))
                    ],
                    onChanged: (value) =>
                        setSheet(() => deployment = value ?? deployment)),
                const SizedBox(height: 10),
                DropdownButtonFormField<String>(
                    value: locationType,
                    decoration: const InputDecoration(
                        labelText: 'Current location type'),
                    items: const [
                      DropdownMenuItem(
                          value: 'station', child: Text('Station')),
                      DropdownMenuItem(value: 'ho', child: Text('Head office')),
                      DropdownMenuItem(
                          value: 'workshop', child: Text('Workshop')),
                      DropdownMenuItem(
                          value: 'in_transit', child: Text('In transit')),
                      DropdownMenuItem(value: 'other', child: Text('Other'))
                    ],
                    onChanged: (value) =>
                        setSheet(() => locationType = value ?? locationType)),
                const SizedBox(height: 10),
                TextField(
                    controller: location,
                    decoration: const InputDecoration(
                        labelText: 'Where is the vehicle now?')),
                const SizedBox(height: 10),
                TextField(
                    controller: comment,
                    maxLines: 2,
                    decoration:
                        const InputDecoration(labelText: 'Latest comment')),
                const SizedBox(height: 16),
                FilledButton(
                    onPressed: () async {
                      try {
                        await api.patch('/api/fleet/vehicles', {
                          'vehicle_no': vehicle['vehicleNo'],
                          'status': status,
                          'deployment_status': deployment,
                          'current_location_type': locationType,
                          'current_location_label': location.text,
                          'status_comment': comment.text
                        });
                        if (context.mounted) Navigator.pop(context);
                        await refresh();
                      } catch (error) {
                        if (context.mounted)
                          showMessage(context, readableError(error));
                      }
                    },
                    style: FilledButton.styleFrom(
                        backgroundColor: brand,
                        minimumSize: const Size.fromHeight(52)),
                    child: const Text('Save vehicle update')),
              ]))));
}

Future<void> showAuditActions(BuildContext context, FleetApi api,
    Map<String, dynamic> audit, Future<void> Function() refresh) async {
  final status = text(audit['status']);
  await showModalBottomSheet(
      context: context,
      useSafeArea: true,
      builder: (context) => Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                    '${text(audit['vehicleNo'])} · ${titleCase(text(audit['auditMode']))}',
                    style: const TextStyle(
                        fontSize: 21, fontWeight: FontWeight.w900)),
                const SizedBox(height: 6),
                Text(
                    '${formatDate(text(audit['scheduledFor']))} · ${text(audit['stationCode'])}',
                    style: const TextStyle(color: Color(0xff687386))),
                const SizedBox(height: 18),
                if (status == 'scheduled')
                  FilledButton.icon(
                      onPressed: () async {
                        await api.post('/api/fleet-control',
                            {'action': 'audit.start', 'auditId': audit['id']});
                        if (context.mounted) Navigator.pop(context);
                        await refresh();
                      },
                      icon: const Icon(Icons.play_arrow_rounded),
                      label: const Text('Start audit'),
                      style: FilledButton.styleFrom(
                          backgroundColor: brand,
                          minimumSize: const Size.fromHeight(50))),
                if (status == 'in_progress')
                  FilledButton.icon(
                      onPressed: () => showMessage(context,
                          'Use the audit checklist to complete required checks and evidence.'),
                      icon: const Icon(Icons.fact_check_outlined),
                      label: const Text('Continue checklist'),
                      style: FilledButton.styleFrom(
                          backgroundColor: brand,
                          minimumSize: const Size.fromHeight(50))),
                const SizedBox(height: 8),
                OutlinedButton(
                    onPressed: () => Navigator.pop(context),
                    child: const Text('Close')),
              ])));
}

Future<void> paymentAction(
    BuildContext context,
    FleetApi api,
    Map<String, dynamic> payment,
    String action,
    Future<void> Function() refresh) async {
  try {
    await api.post('/api/fleet-control/payment-action', {
      'action': action,
      'requestId': payment['id'],
      'status': payment['status'],
      'comments': action == 'return'
          ? 'Returned from Fleet mobile app for correction'
          : 'Updated from Fleet mobile app'
    });
    if (context.mounted)
      showMessage(context,
          action == 'approve' ? 'Payment approved.' : 'Payment returned.');
    await refresh();
  } catch (error) {
    if (context.mounted) showMessage(context, readableError(error));
  }
}

class FleetApi {
  FleetApi._(this.dio, this.preferences);
  final Dio dio;
  final SharedPreferences preferences;

  static Future<FleetApi> create() async {
    final directory = await getApplicationSupportDirectory();
    final jar = PersistCookieJar(
        storage: FileStorage('${directory.path}/fleet-cookies'));
    final dio = Dio(BaseOptions(
        baseUrl: apiOrigin,
        connectTimeout: const Duration(seconds: 15),
        receiveTimeout: const Duration(seconds: 35),
        headers: {'Accept': 'application/json'}));
    dio.interceptors.add(CookieManager(jar));
    return FleetApi._(dio, await SharedPreferences.getInstance());
  }

  Future<void> exchangeSession(Session session) async {
    await dio.post('/api/fleet/mobile/session', data: {
      'accessToken': session.accessToken,
      'refreshToken': session.refreshToken
    });
  }

  Future<bool> hasSession() async {
    try {
      final response = await dio.get('/api/fleet/mobile',
          options: Options(receiveTimeout: const Duration(seconds: 12)));
      return response.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  Future<void> sendWhatsAppOtp(String mobile, String countryCode) async {
    await post('/api/fleet/auth/otp/send',
        {'mobile': mobile, 'countryCode': countryCode});
  }

  Future<void> verifyWhatsAppOtp(
      String mobile, String countryCode, String otp) async {
    await post('/api/fleet/auth/otp/verify', {
      'mobile': mobile,
      'countryCode': countryCode,
      'otp': otp,
      'next': '/fleet-control'
    });
  }

  Future<FleetSnapshot> snapshot() async {
    try {
      final response = await dio.get('/api/fleet/mobile');
      final raw = Map<String, dynamic>.from(response.data as Map);
      await preferences.setString('fleet_snapshot_v2', jsonEncode(raw));
      return FleetSnapshot(raw);
    } on DioException catch (error) {
      if (error.response?.statusCode == 401) {
        final active = Supabase.instance.client.auth.currentSession;
        if (active != null) {
          await exchangeSession(active);
          final retry = await dio.get('/api/fleet/mobile');
          return FleetSnapshot(Map<String, dynamic>.from(retry.data as Map));
        }
      }
      final cached = preferences.getString('fleet_snapshot_v2');
      if (cached != null)
        return FleetSnapshot(
            Map<String, dynamic>.from(jsonDecode(cached) as Map));
      throw ApiError(error.response?.data is Map
          ? text((error.response?.data as Map)['error'])
          : error.message ?? 'Network error');
    }
  }

  Future<Map<String, dynamic>> post(
      String path, Map<String, dynamic> data) async {
    try {
      final response = await dio.post(path, data: data);
      return Map<String, dynamic>.from(response.data as Map);
    } on DioException catch (error) {
      throw ApiError(error.response?.data is Map
          ? text((error.response?.data as Map)['error'])
          : error.message ?? 'Request failed');
    }
  }

  Future<Map<String, dynamic>> patch(
      String path, Map<String, dynamic> data) async {
    try {
      final response = await dio.patch(path, data: data);
      return Map<String, dynamic>.from(response.data as Map);
    } on DioException catch (error) {
      throw ApiError(error.response?.data is Map
          ? text((error.response?.data as Map)['error'])
          : error.message ?? 'Request failed');
    }
  }

  Future<void> logout() async {
    try {
      await dio.delete('/api/fleet/mobile/session');
    } catch (_) {}
    await preferences.remove('fleet_snapshot_v2');
  }
}

class FleetSnapshot {
  FleetSnapshot(this.raw);
  final Map<String, dynamic> raw;
  Map<String, dynamic> get data =>
      raw['data'] is Map ? Map<String, dynamic>.from(raw['data'] as Map) : {};
  String get userName {
    final user = raw['user'] is Map ? raw['user'] as Map : {};
    return text(user['name']).isEmpty
        ? text(user['email'])
        : text(user['name']);
  }

  Map<String, dynamic> map(String key) =>
      data[key] is Map ? Map<String, dynamic>.from(data[key] as Map) : {};
  List<Map<String, dynamic>> list(String key) => data[key] is List
      ? (data[key] as List)
          .whereType<Map>()
          .map((item) => Map<String, dynamic>.from(item))
          .toList()
      : [];
}

class ApiError implements Exception {
  ApiError(this.message);
  final String message;
  @override
  String toString() => message;
}

class ModuleSpec {
  ModuleSpec(this.title, this.icon, this.color, this.key);
  final String title;
  final IconData icon;
  final Color color;
  final String key;
}

class PageHeader extends StatelessWidget {
  const PageHeader(
      {super.key,
      required this.eyebrow,
      required this.title,
      required this.subtitle,
      this.trailing});
  final String eyebrow, title, subtitle;
  final Widget? trailing;
  @override
  Widget build(BuildContext context) =>
      Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(eyebrow,
              style: const TextStyle(
                  color: brand,
                  fontSize: 11,
                  fontWeight: FontWeight.w900,
                  letterSpacing: 1.3)),
          const SizedBox(height: 4),
          Text(title,
              style: const TextStyle(
                  color: ink, fontWeight: FontWeight.w900, fontSize: 28)),
          const SizedBox(height: 3),
          Text(subtitle, style: const TextStyle(color: Color(0xff687386)))
        ])),
        if (trailing != null) trailing!
      ]);
}

class MetricCard extends StatelessWidget {
  const MetricCard(
      {super.key,
      required this.label,
      required this.value,
      required this.tone,
      required this.icon});
  final String label, value;
  final Color tone;
  final IconData icon;
  @override
  Widget build(BuildContext context) => Card(
      child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Icon(icon, color: tone, size: 21),
                Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
                  Expanded(
                      child: Text(value,
                          style: TextStyle(
                              color: tone,
                              fontSize: 25,
                              fontWeight: FontWeight.w900))),
                  Text(label,
                      style: const TextStyle(
                          color: Color(0xff687386),
                          fontSize: 11,
                          fontWeight: FontWeight.w700))
                ])
              ])));
}

class SectionTitle extends StatelessWidget {
  const SectionTitle({super.key, required this.title, this.caption});
  final String title;
  final String? caption;
  @override
  Widget build(BuildContext context) => Row(children: [
        Expanded(
            child: Text(title,
                style: const TextStyle(
                    fontWeight: FontWeight.w900, fontSize: 18, color: ink))),
        if (caption != null)
          Text(caption!,
              style: const TextStyle(fontSize: 11, color: Color(0xff7b8495)))
      ]);
}

class SummaryRow extends StatelessWidget {
  const SummaryRow(
      {super.key,
      required this.icon,
      required this.label,
      required this.value});
  final IconData icon;
  final String label, value;
  @override
  Widget build(BuildContext context) => Row(children: [
        Icon(icon, size: 20, color: const Color(0xff687386)),
        const SizedBox(width: 11),
        Expanded(child: Text(label)),
        Text(value,
            style: const TextStyle(fontWeight: FontWeight.w900, fontSize: 16))
      ]);
}

class VehicleTile extends StatelessWidget {
  const VehicleTile(
      {super.key, required this.vehicle, this.showLocation = false});
  final Map<String, dynamic> vehicle;
  final bool showLocation;
  @override
  Widget build(BuildContext context) => Card(
      margin: const EdgeInsets.only(bottom: 9),
      child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(children: [
            StatusIcon(
                status: text(vehicle['status']),
                icon: Icons.local_shipping_outlined),
            const SizedBox(width: 12),
            Expanded(
                child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                  Text(text(vehicle['vehicleNo']),
                      style: const TextStyle(
                          fontWeight: FontWeight.w900, fontSize: 16)),
                  const SizedBox(height: 2),
                  Text(
                      '${text(vehicle['stationCode'])} · ${text(vehicle['model'])}',
                      style: const TextStyle(color: Color(0xff687386))),
                  if (showLocation)
                    Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: Text(
                            'Now: ${text(vehicle['currentLocationLabel']).isEmpty ? text(vehicle['stationCode']) : text(vehicle['currentLocationLabel'])}',
                            style: const TextStyle(
                                fontSize: 12, color: Color(0xff4f596b))))
                ])),
            StatusPill(status: text(vehicle['status']))
          ])));
}

class StatusIcon extends StatelessWidget {
  const StatusIcon({super.key, required this.status, required this.icon});
  final String status;
  final IconData icon;
  @override
  Widget build(BuildContext context) {
    final color = statusColor(status);
    return Container(
        width: 42,
        height: 42,
        decoration: BoxDecoration(
            color: color.withValues(alpha: .11),
            borderRadius: BorderRadius.circular(12)),
        child: Icon(icon, color: color));
  }
}

class StatusPill extends StatelessWidget {
  const StatusPill({super.key, required this.status});
  final String status;
  @override
  Widget build(BuildContext context) {
    final color = statusColor(status);
    return Container(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
        decoration: BoxDecoration(
            color: color.withValues(alpha: .10),
            borderRadius: BorderRadius.circular(99)),
        child: Text(titleCase(status),
            style: TextStyle(
                color: color, fontWeight: FontWeight.w800, fontSize: 10)));
  }
}

class EmptyCard extends StatelessWidget {
  const EmptyCard(
      {super.key,
      required this.icon,
      required this.title,
      required this.message});
  final IconData icon;
  final String title, message;
  @override
  Widget build(BuildContext context) => Card(
      child: Padding(
          padding: const EdgeInsets.all(25),
          child: Column(children: [
            Icon(icon, color: const Color(0xff8a93a3), size: 34),
            const SizedBox(height: 10),
            Text(title,
                style:
                    const TextStyle(fontWeight: FontWeight.w900, fontSize: 17)),
            const SizedBox(height: 5),
            Text(message,
                textAlign: TextAlign.center,
                style: const TextStyle(color: Color(0xff7b8495)))
          ])));
}

class BrandedLoader extends StatelessWidget {
  const BrandedLoader({super.key, required this.label});
  final String label;
  @override
  Widget build(BuildContext context) => Scaffold(
          body: Center(
              child: Column(mainAxisSize: MainAxisSize.min, children: [
        Container(
            width: 58,
            height: 58,
            decoration: BoxDecoration(
                color: ink, borderRadius: BorderRadius.circular(18)),
            child:
                const Icon(Icons.route_rounded, color: Colors.white, size: 30)),
        const SizedBox(height: 20),
        const CircularProgressIndicator(color: brand),
        const SizedBox(height: 14),
        Text(label, style: const TextStyle(color: Color(0xff687386)))
      ])));
}

class ErrorView extends StatelessWidget {
  const ErrorView(
      {super.key,
      required this.message,
      required this.retry,
      required this.logout});
  final String message;
  final VoidCallback retry, logout;
  @override
  Widget build(BuildContext context) => Scaffold(
      body: Center(
          child: Padding(
              padding: const EdgeInsets.all(28),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                const Icon(Icons.cloud_off_rounded, size: 46, color: brand),
                const SizedBox(height: 13),
                Text(message, textAlign: TextAlign.center),
                const SizedBox(height: 16),
                FilledButton(onPressed: retry, child: const Text('Try again')),
                TextButton(onPressed: logout, child: const Text('Sign out'))
              ]))));
}

String text(dynamic value) => value == null ? '' : value.toString().trim();
double number(dynamic value) => double.tryParse(text(value)) ?? 0;
String readableError(dynamic error) => error is ApiError
    ? error.message
    : error is AuthException
        ? error.message
        : error.toString().replaceFirst('Exception: ', '');
String titleCase(String value) => value
    .replaceAll('_', ' ')
    .split(' ')
    .where((part) => part.isNotEmpty)
    .map((part) => '${part[0].toUpperCase()}${part.substring(1).toLowerCase()}')
    .join(' ');
String currency(dynamic value) =>
    NumberFormat.currency(locale: 'en_IN', symbol: '₹', decimalDigits: 0)
        .format(number(value));
String formatDate(String value) {
  final parsed = DateTime.tryParse(value);
  return parsed == null
      ? value
      : DateFormat('d MMM yyyy').format(parsed.toLocal());
}

String greeting() {
  final hour = DateTime.now().hour;
  return hour < 12
      ? 'Good morning'
      : hour < 17
          ? 'Good afternoon'
          : 'Good evening';
}

Color statusColor(String status) {
  final value = status.toLowerCase();
  if (['active', 'approved', 'passed', 'completed', 'paid'].contains(value))
    return const Color(0xff087f5b);
  if (['breakdown', 'rejected', 'failed', 'disposed'].contains(value))
    return const Color(0xffc92a2a);
  if (['under_service', 'pending', 'scheduled', 'returned'].contains(value))
    return const Color(0xffb36b00);
  if (value == 'in_progress') return const Color(0xff1971c2);
  return const Color(0xff687386);
}

void showMessage(BuildContext context, String message) =>
    ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(message), behavior: SnackBarBehavior.floating));
