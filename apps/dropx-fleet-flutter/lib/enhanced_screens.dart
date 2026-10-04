part of 'main.dart';

String _dayKey([DateTime? value]) =>
    DateFormat('yyyy-MM-dd').format(value ?? DateTime.now());

class EnhancedTodayScreen extends StatelessWidget {
  const EnhancedTodayScreen(
      {super.key,
      required this.api,
      required this.snapshot,
      required this.refresh,
      required this.openTab});
  final FleetApi api;
  final FleetSnapshot snapshot;
  final Future<void> Function() refresh;
  final ValueChanged<int> openTab;

  @override
  Widget build(BuildContext context) {
    final counts = snapshot.map('counts');
    final today = _dayKey();
    final audits = snapshot
        .list('audits')
        .where((a) =>
            text(a['scheduledFor']).startsWith(today) &&
            ['scheduled', 'in_progress'].contains(text(a['status'])))
        .toList();
    final approvals = snapshot
        .list('payments')
        .where((p) => p['canApprove'] == true)
        .toList();
    final gps = snapshot.summaryList('gpsLive');
    final moving = gps.where((g) => number(g['speed']) > 0).length;
    final unavailable = snapshot
        .list('vehicles')
        .where((v) => text(v['status']) != 'active')
        .take(4)
        .toList();
    return RefreshIndicator(
        onRefresh: refresh,
        child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 30),
            children: [
              _DashboardHero(
                  name: snapshot.userName, moving: moving, onRefresh: refresh),
              const SizedBox(height: 16),
              GridView.count(
                  shrinkWrap: true,
                  physics: const NeverScrollableScrollPhysics(),
                  crossAxisCount: 2,
                  childAspectRatio: 1.42,
                  mainAxisSpacing: 10,
                  crossAxisSpacing: 10,
                  children: [
                    _ActionMetric(
                        label: 'Audits today',
                        value: '${audits.length}',
                        icon: Icons.fact_check_outlined,
                        tone: brand,
                        onTap: () => openTab(2)),
                    _ActionMetric(
                        label: 'My approvals',
                        value: '${approvals.length}',
                        icon: Icons.approval_outlined,
                        tone: const Color(0xffd97706),
                        onTap: () => openTab(3)),
                    _ActionMetric(
                        label: 'Moving now',
                        value: '$moving',
                        icon: Icons.route_outlined,
                        tone: const Color(0xff087f5b),
                        onTap: () => Navigator.push(
                            context,
                            MaterialPageRoute(
                                builder: (_) => EnhancedTrackingScreen(
                                    snapshot: snapshot)))),
                    _ActionMetric(
                        label: 'Unavailable',
                        value: '${counts['unavailable'] ?? unavailable.length}',
                        icon: Icons.warning_amber_rounded,
                        tone: const Color(0xffc92a2a),
                        onTap: () => openTab(1)),
                  ]),
              const SizedBox(height: 22),
              Row(children: [
                const Expanded(child: SectionTitle(title: "Today's audits")),
                TextButton(
                    onPressed: () => openTab(2),
                    child: const Text('View programme'))
              ]),
              if (audits.isEmpty)
                const EmptyCard(
                    icon: Icons.event_available_rounded,
                    title: 'No audit due today',
                    message:
                        'Scheduled physical and virtual audits will appear here.'),
              ...audits.map((audit) => _AuditCard(
                  audit: audit,
                  onTap: () async {
                    await _openAudit(context, api, snapshot, audit, refresh);
                  })),
              const SizedBox(height: 20),
              const SectionTitle(title: 'Fleet exceptions'),
              const SizedBox(height: 9),
              if (unavailable.isEmpty)
                const EmptyCard(
                    icon: Icons.verified_outlined,
                    title: 'No availability exception',
                    message: 'All vehicles in your scope are operational.'),
              ...unavailable
                  .map((v) => VehicleTile(vehicle: v, showLocation: true)),
              const SizedBox(height: 20),
              const SectionTitle(title: 'Quick access'),
              const SizedBox(height: 9),
              Row(children: [
                Expanded(
                    child: _QuickButton(
                        icon: Icons.location_on_outlined,
                        label: 'Live tracking',
                        onTap: () => Navigator.push(
                            context,
                            MaterialPageRoute(
                                builder: (_) => EnhancedTrackingScreen(
                                    snapshot: snapshot))))),
                const SizedBox(width: 9),
                Expanded(
                    child: _QuickButton(
                        icon: Icons.local_gas_station_outlined,
                        label: 'Fuel analytics',
                        onTap: () => Navigator.push(
                            context,
                            MaterialPageRoute(
                                builder: (_) =>
                                    EnhancedFuelScreen(snapshot: snapshot))))),
              ]),
            ]));
  }
}

class _ActionMetric extends StatelessWidget {
  const _ActionMetric(
      {required this.label,
      required this.value,
      required this.icon,
      required this.tone,
      required this.onTap});
  final String label, value;
  final IconData icon;
  final Color tone;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Card(
      child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(12),
          child: Padding(
              padding: const EdgeInsets.all(14),
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Container(
                        width: 36,
                        height: 36,
                        decoration: BoxDecoration(
                            color: tone.withValues(alpha: .1),
                            borderRadius: BorderRadius.circular(10)),
                        child: Icon(icon, color: tone, size: 20)),
                    const Spacer(),
                    Text(value,
                        style: TextStyle(
                            fontSize: 26,
                            fontWeight: FontWeight.w900,
                            color: tone)),
                    Text(label,
                        style: const TextStyle(
                            color: Color(0xff687386),
                            fontWeight: FontWeight.w700))
                  ]))));
}

class _DashboardHero extends StatelessWidget {
  const _DashboardHero(
      {required this.name, required this.moving, required this.onRefresh});
  final String name;
  final int moving;
  final VoidCallback onRefresh;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(20),
        decoration: BoxDecoration(
          gradient: const LinearGradient(
              colors: [Color(0xff111b33), Color(0xff24365f)],
              begin: Alignment.topLeft,
              end: Alignment.bottomRight),
          borderRadius: BorderRadius.circular(24),
          boxShadow: const [
            BoxShadow(
                color: Color(0x22121b31), blurRadius: 24, offset: Offset(0, 10))
          ],
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Container(
                width: 42,
                height: 42,
                decoration: BoxDecoration(
                    color: Colors.white.withValues(alpha: .12),
                    borderRadius: BorderRadius.circular(13)),
                child: const Icon(Icons.local_shipping_rounded,
                    color: Colors.white)),
            const SizedBox(width: 12),
            const Expanded(
                child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                  Text('DROPX FLEET',
                      style: TextStyle(
                          color: Color(0xffffb5cd),
                          fontSize: 11,
                          fontWeight: FontWeight.w900,
                          letterSpacing: 1.5)),
                  Text('Operations control',
                      style: TextStyle(
                          color: Colors.white,
                          fontSize: 20,
                          fontWeight: FontWeight.w900))
                ])),
            IconButton(
                onPressed: onRefresh,
                style: IconButton.styleFrom(
                    backgroundColor: Colors.white.withValues(alpha: .1)),
                icon: const Icon(Icons.refresh_rounded, color: Colors.white)),
          ]),
          const SizedBox(height: 22),
          Text(greeting(),
              style: const TextStyle(
                  color: Colors.white,
                  fontSize: 27,
                  height: 1.05,
                  fontWeight: FontWeight.w900)),
          const SizedBox(height: 5),
          Text(name,
              style: const TextStyle(
                  color: Color(0xffc8d1e5), fontWeight: FontWeight.w600)),
          const SizedBox(height: 16),
          Container(
              padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 8),
              decoration: BoxDecoration(
                  color: const Color(0xff0f766e),
                  borderRadius: BorderRadius.circular(99)),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                const SizedBox(
                    width: 7,
                    height: 7,
                    child: DecoratedBox(
                        decoration: BoxDecoration(
                            color: Color(0xff70f0cc), shape: BoxShape.circle))),
                const SizedBox(width: 7),
                Text('$moving vehicles moving now',
                    style: const TextStyle(
                        color: Colors.white,
                        fontSize: 12,
                        fontWeight: FontWeight.w800))
              ])),
        ]),
      );
}

class _QuickButton extends StatelessWidget {
  const _QuickButton(
      {required this.icon, required this.label, required this.onTap});
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => OutlinedButton.icon(
      onPressed: onTap,
      icon: Icon(icon),
      label: Text(label),
      style: OutlinedButton.styleFrom(
          minimumSize: const Size.fromHeight(54),
          padding: const EdgeInsets.symmetric(horizontal: 10)));
}

class EnhancedAuditsScreen extends StatefulWidget {
  const EnhancedAuditsScreen(
      {super.key,
      required this.api,
      required this.snapshot,
      required this.refresh});
  final FleetApi api;
  final FleetSnapshot snapshot;
  final Future<void> Function() refresh;
  @override
  State<EnhancedAuditsScreen> createState() => _EnhancedAuditsScreenState();
}

class _EnhancedAuditsScreenState extends State<EnhancedAuditsScreen> {
  int view = 0;
  String query = '';
  String mode = 'all';
  String station = 'all';
  @override
  Widget build(BuildContext context) {
    final today = _dayKey();
    final all = widget.snapshot.list('audits')
      ..sort(
          (a, b) => text(a['scheduledFor']).compareTo(text(b['scheduledFor'])));
    final stations = [
      'all',
      ...{for (final a in all) text(a['stationCode'])}
          .where((s) => s.isNotEmpty)
          .toList()
        ..sort()
    ];
    final rows = all.where((a) {
      final status = text(a['status']);
      final bucket = view == 0
          ? text(a['scheduledFor']).startsWith(today) &&
              ['scheduled', 'in_progress'].contains(status)
          : view == 1
              ? ['scheduled', 'in_progress'].contains(status)
              : ['passed', 'failed', 'cancelled'].contains(status);
      final hay = '${a['vehicleNo']} ${a['stationCode']} ${a['auditMode']}'
          .toLowerCase();
      return bucket &&
          hay.contains(query.toLowerCase()) &&
          (mode == 'all' || text(a['auditMode']) == mode) &&
          (station == 'all' || text(a['stationCode']) == station);
    }).toList();
    return RefreshIndicator(
        onRefresh: widget.refresh,
        child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 30),
            children: [
              const PageHeader(
                  eyebrow: 'ASSURANCE PROGRAMME',
                  title: 'Vehicle audits',
                  subtitle: 'One physical and one virtual audit per vehicle'),
              const SizedBox(height: 14),
              SegmentedButton<int>(segments: const [
                ButtonSegment(value: 0, label: Text('Today')),
                ButtonSegment(value: 1, label: Text('Open')),
                ButtonSegment(value: 2, label: Text('History'))
              ], selected: {
                view
              }, onSelectionChanged: (v) => setState(() => view = v.first)),
              const SizedBox(height: 12),
              TextField(
                  onChanged: (v) => setState(() => query = v),
                  decoration: const InputDecoration(
                      prefixIcon: Icon(Icons.search),
                      hintText: 'Vehicle or station')),
              const SizedBox(height: 9),
              Row(children: [
                Expanded(
                    child: DropdownButtonFormField<String>(
                        value: mode,
                        decoration:
                            const InputDecoration(labelText: 'Audit type'),
                        items: const [
                          DropdownMenuItem(
                              value: 'all', child: Text('All types')),
                          DropdownMenuItem(
                              value: 'physical', child: Text('Physical')),
                          DropdownMenuItem(
                              value: 'video', child: Text('Virtual'))
                        ],
                        onChanged: (v) => setState(() => mode = v ?? 'all'))),
                const SizedBox(width: 8),
                Expanded(
                    child: DropdownButtonFormField<String>(
                        value: station,
                        decoration: const InputDecoration(labelText: 'Station'),
                        items: stations
                            .map((s) => DropdownMenuItem(
                                value: s,
                                child: Text(s == 'all' ? 'All stations' : s)))
                            .toList(),
                        onChanged: (v) => setState(() => station = v ?? 'all')))
              ]),
              const SizedBox(height: 14),
              Text('${rows.length} audit${rows.length == 1 ? '' : 's'}',
                  style: const TextStyle(
                      fontWeight: FontWeight.w800, color: Color(0xff687386))),
              const SizedBox(height: 9),
              if (rows.isEmpty)
                const EmptyCard(
                    icon: Icons.fact_check_outlined,
                    title: 'No audits in this view',
                    message: 'Change the filters or refresh the programme.'),
              ...rows.map((a) => _AuditCard(
                  audit: a,
                  onTap: () => _openAudit(context, widget.api, widget.snapshot,
                      a, widget.refresh))),
            ]));
  }
}

class _AuditCard extends StatelessWidget {
  const _AuditCard({required this.audit, required this.onTap});
  final Map<String, dynamic> audit;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final virtual = text(audit['auditMode']) == 'video';
    return Card(
      margin: const EdgeInsets.only(bottom: 9),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(children: [
            StatusIcon(
                status: text(audit['status']),
                icon: virtual
                    ? Icons.videocam_outlined
                    : Icons.directions_car_outlined),
            const SizedBox(width: 12),
            Expanded(
                child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                  Text(text(audit['vehicleNo']),
                      style: const TextStyle(
                          fontWeight: FontWeight.w900, fontSize: 16)),
                  Text(
                      '${virtual ? 'Virtual audit' : 'Physical audit'} · ${text(audit['stationCode'])}',
                      style: const TextStyle(color: Color(0xff687386))),
                  const SizedBox(height: 4),
                  Text(formatDate(text(audit['scheduledFor'])),
                      style: const TextStyle(fontWeight: FontWeight.w700)),
                ])),
            Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
              StatusPill(status: text(audit['status'])),
              const SizedBox(height: 8),
              Icon(
                  ['scheduled', 'in_progress'].contains(text(audit['status']))
                      ? Icons.arrow_forward_rounded
                      : Icons.chevron_right,
                  size: 18),
            ]),
          ]),
        ),
      ),
    );
  }
}

Future<void> _openAudit(
    BuildContext context,
    FleetApi api,
    FleetSnapshot snapshot,
    Map<String, dynamic> audit,
    Future<void> Function() refresh) async {
  var active = audit;
  if (text(audit['status']) == 'scheduled') {
    final start = await showDialog<bool>(
        context: context,
        builder: (c) => AlertDialog(
                title: Text(
                    'Start ${text(audit['auditMode']) == 'video' ? 'virtual' : 'physical'} audit?'),
                content: Text(
                    '${text(audit['vehicleNo'])} · ${text(audit['stationCode'])}\nThe configured checklist will open now.'),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(c, false),
                      child: const Text('Not now')),
                  FilledButton(
                      onPressed: () => Navigator.pop(c, true),
                      child: const Text('Start audit'))
                ]));
    if (start != true || !context.mounted) return;
    try {
      await api.post('/api/fleet-control',
          {'action': 'audit.start', 'auditId': audit['id']});
      active = {...audit, 'status': 'in_progress'};
      await refresh();
    } catch (e) {
      if (context.mounted) showMessage(context, readableError(e));
      return;
    }
  }
  if (!context.mounted) return;
  if (text(active['status']) == 'in_progress') {
    await Navigator.push(
        context,
        MaterialPageRoute(
            builder: (_) => AuditChecklistScreen(
                api: api, snapshot: snapshot, audit: active)));
    await refresh();
  } else {
    await showModalBottomSheet(
        context: context,
        useSafeArea: true,
        builder: (c) => Padding(
            padding: const EdgeInsets.all(20),
            child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(text(active['vehicleNo']),
                      style: const TextStyle(
                          fontSize: 22, fontWeight: FontWeight.w900)),
                  const SizedBox(height: 6),
                  Text(
                      '${titleCase(text(active['auditMode']))} · ${text(active['stationCode'])} · ${formatDate(text(active['scheduledFor']))}'),
                  const SizedBox(height: 12),
                  StatusPill(status: text(active['status'])),
                  if (text(active['summary']).isNotEmpty) ...[
                    const SizedBox(height: 12),
                    Text(text(active['summary']))
                  ],
                  const SizedBox(height: 14),
                  OutlinedButton(
                      onPressed: () => Navigator.pop(c),
                      child: const Text('Close'))
                ])));
  }
}

class AuditChecklistScreen extends StatefulWidget {
  const AuditChecklistScreen(
      {super.key,
      required this.api,
      required this.snapshot,
      required this.audit});
  final FleetApi api;
  final FleetSnapshot snapshot;
  final Map<String, dynamic> audit;
  @override
  State<AuditChecklistScreen> createState() => _AuditChecklistScreenState();
}

class _AuditChecklistScreenState extends State<AuditChecklistScreen> {
  final values = <String, String>{};
  final remarks = <String, TextEditingController>{};
  final evidence = <String, TextEditingController>{};
  final summary = TextEditingController();
  final odometer = TextEditingController();
  final video = TextEditingController();
  bool busy = false;
  String? expanded;
  List<Map<String, dynamic>> get items {
    final template = text(widget.audit['templateId']);
    final mode = text(widget.audit['auditMode']);
    return widget.snapshot
        .list('checklistItems')
        .where((i) =>
            (template.isEmpty || text(i['templateId']) == template) &&
            ['both', mode, ''].contains(text(i['auditMode'])))
        .toList()
      ..sort(
          (a, b) => number(a['sortOrder']).compareTo(number(b['sortOrder'])));
  }

  @override
  void dispose() {
    for (final c in remarks.values) c.dispose();
    for (final c in evidence.values) c.dispose();
    summary.dispose();
    odometer.dispose();
    video.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final groups = <String, List<Map<String, dynamic>>>{};
    for (final item in items) {
      groups
          .putIfAbsent(
              text(item['category']).isEmpty
                  ? 'General'
                  : text(item['category']),
              () => [])
          .add(item);
    }
    final answered = values.values.where((v) => v.isNotEmpty).length;
    return Scaffold(
        appBar: AppBar(title: Text('${text(widget.audit['vehicleNo'])} audit')),
        body: SafeArea(
            child: Column(children: [
          Container(
              color: Colors.white,
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 14),
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(children: [
                      Expanded(
                          child: Text(
                              '${text(widget.audit['auditMode']) == 'video' ? 'Virtual' : 'Physical'} · ${text(widget.audit['stationCode'])}',
                              style: const TextStyle(
                                  fontWeight: FontWeight.w800))),
                      Text('$answered/${items.length}',
                          style: const TextStyle(
                              color: brand, fontWeight: FontWeight.w900))
                    ]),
                    const SizedBox(height: 8),
                    LinearProgressIndicator(
                        value: items.isEmpty ? 0 : answered / items.length,
                        color: brand,
                        backgroundColor: const Color(0xfff5d7e2))
                  ])),
          Expanded(
              child: ListView(padding: const EdgeInsets.all(14), children: [
            if (items.isEmpty)
              const EmptyCard(
                  icon: Icons.rule_folder_outlined,
                  title: 'Checklist not configured',
                  message:
                      'An administrator must assign active controls to this audit template.'),
            ...groups.entries.map((g) => Card(
                margin: const EdgeInsets.only(bottom: 10),
                child: ExpansionTile(
                    initiallyExpanded: expanded == null || expanded == g.key,
                    onExpansionChanged: (v) {
                      if (v) setState(() => expanded = g.key);
                    },
                    title: Text(g.key,
                        style: const TextStyle(fontWeight: FontWeight.w900)),
                    subtitle: Text(
                        '${g.value.where((i) => values[text(i['id'])]?.isNotEmpty == true).length}/${g.value.length} complete'),
                    children: g.value
                        .asMap()
                        .entries
                        .map((entry) => _check(entry.value, entry.key + 1))
                        .toList()))),
            if (text(widget.audit['auditMode']) == 'video') ...[
              const SizedBox(height: 8),
              TextField(
                  controller: video,
                  decoration: const InputDecoration(
                      labelText: 'Full walk-around video link *',
                      prefixIcon: Icon(Icons.video_library_outlined)))
            ],
            const SizedBox(height: 10),
            TextField(
                controller: odometer,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(
                    labelText: 'Odometer (km)',
                    prefixIcon: Icon(Icons.speed_outlined))),
            const SizedBox(height: 10),
            TextField(
                controller: summary,
                maxLines: 3,
                decoration: const InputDecoration(
                    labelText: 'Audit summary',
                    hintText: 'Major findings or overall condition')),
            const SizedBox(height: 80)
          ])),
          Container(
              color: Colors.white,
              padding: const EdgeInsets.fromLTRB(14, 10, 14, 14),
              child: SafeArea(
                  top: false,
                  child: FilledButton.icon(
                      onPressed: busy || items.isEmpty ? null : _submit,
                      icon: busy
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(
                                  strokeWidth: 2, color: Colors.white))
                          : const Icon(Icons.check_circle_outline),
                      label:
                          Text(busy ? 'Submitting audit…' : 'Complete audit'),
                      style: FilledButton.styleFrom(
                          backgroundColor: brand,
                          minimumSize: const Size.fromHeight(54)))))
        ])));
  }

  Widget _check(Map<String, dynamic> item, int index) {
    final id = text(item['id']);
    final type = text(item['responseType']);
    remarks.putIfAbsent(id, () => TextEditingController());
    evidence.putIfAbsent(id, () => TextEditingController());
    final value = values[id] ?? '';
    final failed = value == 'fail' || value == 'no';
    final evidenceType = failed
        ? text(item['failEvidenceType'])
        : text(item['passEvidenceType']);
    final min = (failed
            ? number(item['failMinEvidence'])
            : number(item['passMinEvidence']))
        .round();
    Widget input;
    if (type == 'pass_fail' || type == 'yes_no') {
      final good = type == 'yes_no' ? 'yes' : 'pass',
          bad = type == 'yes_no' ? 'no' : 'fail';
      input = Row(children: [
        Expanded(
            child: ChoiceChip(
                label: Text(type == 'yes_no' ? 'Yes' : 'Compliant'),
                selected: value == good,
                onSelected: (_) => setState(() => values[id] = good))),
        const SizedBox(width: 8),
        Expanded(
            child: ChoiceChip(
                label: Text(type == 'yes_no' ? 'No' : 'Non-compliant'),
                selected: value == bad,
                selectedColor: const Color(0xffffdce3),
                onSelected: (_) => setState(() => values[id] = bad)))
      ]);
    } else {
      input = TextFormField(
          initialValue: value,
          keyboardType: type == 'number' ? TextInputType.number : null,
          decoration:
              InputDecoration(labelText: type == 'date' ? 'Date' : 'Response'),
          onChanged: (v) => setState(() => values[id] = v));
    }
    return Padding(
        padding: const EdgeInsets.fromLTRB(14, 6, 14, 16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(
              '$index. ${text(item['label'])}${item['isRequired'] == true ? ' *' : ''}',
              style:
                  const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
          if (text(item['guidance']).isNotEmpty)
            Padding(
                padding: const EdgeInsets.only(top: 3),
                child: Text(text(item['guidance']),
                    style: const TextStyle(
                        color: Color(0xff687386), fontSize: 12))),
          const SizedBox(height: 10),
          input,
          const SizedBox(height: 8),
          TextField(
              controller: remarks[id],
              maxLines: 2,
              decoration: InputDecoration(
                  labelText: failed && item['failRemarksRequired'] == true
                      ? 'Remark *'
                      : 'Add remark (optional)',
                  prefixIcon: const Icon(Icons.add_comment_outlined))),
          if (min > 0) ...[
            const SizedBox(height: 8),
            TextField(
                controller: evidence[id],
                minLines: 1,
                maxLines: 3,
                decoration: InputDecoration(
                    labelText:
                        '$evidenceType evidence ${min == 1 ? 'link' : 'links'} *',
                    helperText: min == 1
                        ? 'Paste the evidence link'
                        : 'Paste $min links, one per line',
                    prefixIcon: const Icon(Icons.attach_file)))
          ],
          const Divider(height: 24)
        ]));
  }

  Future<void> _submit() async {
    final missing = items
        .where((i) =>
            i['isRequired'] == true && (values[text(i['id'])]?.isEmpty ?? true))
        .toList();
    if (missing.isNotEmpty) {
      showMessage(context,
          'Complete all required checks (${missing.length} remaining).');
      return;
    }
    final evidenceRows = <Map<String, dynamic>>[];
    for (final item in items) {
      final id = text(item['id']);
      final failed = ['fail', 'no'].contains(values[id]);
      if (failed &&
          item['failRemarksRequired'] == true &&
          (remarks[id]?.text.trim().isEmpty ?? true)) {
        showMessage(context, 'Add a remark for ${text(item['label'])}.');
        return;
      }
      final links = (evidence[id]?.text ?? '')
          .split(RegExp(r'[\n,]+'))
          .map((value) => value.trim())
          .where((value) => value.isNotEmpty)
          .toList();
      final min = (failed
              ? number(item['failMinEvidence'])
              : number(item['passMinEvidence']))
          .round();
      final evidenceType = failed
          ? text(item['failEvidenceType'])
          : text(item['passEvidenceType']);
      if (min > 0 && links.length < min) {
        showMessage(context,
            'Attach $min $evidenceType ${min == 1 ? 'link' : 'links'} for ${text(item['label'])}.');
        return;
      }
      for (final link in links) {
        evidenceRows.add({
          'itemId': id,
          'type': evidenceType == 'any' ? 'photo' : evidenceType,
          'url': link,
          'caption': text(item['label'])
        });
      }
    }
    if (text(widget.audit['auditMode']) == 'video') {
      if (video.text.trim().isEmpty) {
        showMessage(context, 'Add the complete walk-around video link.');
        return;
      }
      evidenceRows.add({
        'type': 'video',
        'url': video.text.trim(),
        'caption': 'Complete vehicle walk-around'
      });
    }
    setState(() => busy = true);
    try {
      await widget.api.post('/api/fleet-control', {
        'action': 'audit.complete',
        'auditId': widget.audit['id'],
        'odometerKm': odometer.text,
        'summary': summary.text,
        'sendEmail': true,
        'responses': items.map((i) {
          final id = text(i['id']);
          final v = values[id] ?? '';
          return {
            'itemId': id,
            'value': v,
            'passed': ['pass', 'yes'].contains(v)
                ? true
                : ['fail', 'no'].contains(v)
                    ? false
                    : null,
            'comments': remarks[id]?.text ?? ''
          };
        }).toList(),
        'evidence': evidenceRows,
        'findings': []
      });
      if (mounted) {
        showMessage(context, 'Audit completed successfully.');
        Navigator.pop(context, true);
      }
    } catch (e) {
      if (mounted) showMessage(context, readableError(e));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }
}

class EnhancedPaymentsScreen extends StatefulWidget {
  const EnhancedPaymentsScreen(
      {super.key,
      required this.api,
      required this.snapshot,
      required this.refresh});
  final FleetApi api;
  final FleetSnapshot snapshot;
  final Future<void> Function() refresh;
  @override
  State<EnhancedPaymentsScreen> createState() => _EnhancedPaymentsScreenState();
}

class _EnhancedPaymentsScreenState extends State<EnhancedPaymentsScreen> {
  int view = 0;
  String query = '';
  String station = 'all';
  @override
  Widget build(BuildContext context) {
    final all = widget.snapshot.list('payments');
    final stations = [
      'all',
      ...{for (final p in all) text(p['stationCode'])}
          .where((s) => s.isNotEmpty)
          .toList()
        ..sort()
    ];
    final rows = all.where((p) {
      final actionable = p['canApprove'] == true;
      final status = text(p['status']).toLowerCase();
      final pending = actionable ||
          ['pending', 'submitted', 'in_review', 'returned'].contains(status);
      final bucket = view == 0
          ? actionable
          : view == 1
              ? pending
              : !pending;
      final hay =
          '${p['requestNo']} ${p['stationCode']} ${p['head']} ${p['requestedBy']} ${p['remarks']}'
              .toLowerCase();
      return bucket &&
          hay.contains(query.toLowerCase()) &&
          (station == 'all' || text(p['stationCode']) == station);
    }).toList();
    return RefreshIndicator(
        onRefresh: widget.refresh,
        child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 30),
            children: [
              const PageHeader(
                  eyebrow: 'ACTION INBOX',
                  title: 'Vehicle payments',
                  subtitle: 'Review complete details before taking action'),
              const SizedBox(height: 14),
              SegmentedButton<int>(segments: const [
                ButtonSegment(value: 0, label: Text('My action')),
                ButtonSegment(value: 1, label: Text('Open')),
                ButtonSegment(value: 2, label: Text('Processed'))
              ], selected: {
                view
              }, onSelectionChanged: (v) => setState(() => view = v.first)),
              const SizedBox(height: 12),
              TextField(
                  onChanged: (v) => setState(() => query = v),
                  decoration: const InputDecoration(
                      prefixIcon: Icon(Icons.search),
                      hintText: 'Request, person, station or purpose')),
              const SizedBox(height: 9),
              DropdownButtonFormField<String>(
                  value: station,
                  decoration: const InputDecoration(labelText: 'Station'),
                  items: stations
                      .map((s) => DropdownMenuItem(
                          value: s,
                          child: Text(s == 'all' ? 'All stations' : s)))
                      .toList(),
                  onChanged: (v) => setState(() => station = v ?? 'all')),
              const SizedBox(height: 14),
              if (rows.isEmpty)
                const EmptyCard(
                    icon: Icons.done_all_rounded,
                    title: 'No requests in this view',
                    message:
                        'Processed items are kept separate from your action inbox.'),
              ...rows.map((p) => Card(
                  margin: const EdgeInsets.only(bottom: 9),
                  child: InkWell(
                      onTap: () => Navigator.push(
                          context,
                          MaterialPageRoute(
                              builder: (_) => PaymentDetailScreen(
                                  api: widget.api,
                                  payment: p,
                                  refresh: widget.refresh))),
                      borderRadius: BorderRadius.circular(12),
                      child: Padding(
                          padding: const EdgeInsets.all(14),
                          child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(children: [
                                  Expanded(
                                      child: Text(
                                          text(p['requestNo']).isEmpty
                                              ? 'Payment request'
                                              : text(p['requestNo']),
                                          style: const TextStyle(
                                              fontWeight: FontWeight.w900,
                                              fontSize: 16))),
                                  Text(currency(p['amount']),
                                      style: const TextStyle(
                                          fontWeight: FontWeight.w900,
                                          fontSize: 17))
                                ]),
                                const SizedBox(height: 5),
                                Text(
                                    '${text(p['stationCode'])} · ${text(p['head'])}',
                                    style: const TextStyle(
                                        color: Color(0xff687386))),
                                if (text(p['remarks']).isNotEmpty) ...[
                                  const SizedBox(height: 6),
                                  Text(text(p['remarks']),
                                      maxLines: 2,
                                      overflow: TextOverflow.ellipsis)
                                ],
                                const SizedBox(height: 10),
                                Row(children: [
                                  StatusPill(status: text(p['status'])),
                                  const Spacer(),
                                  const Text('View details',
                                      style: TextStyle(
                                          color: brand,
                                          fontWeight: FontWeight.w800)),
                                  const Icon(Icons.chevron_right,
                                      color: brand, size: 18)
                                ])
                              ]))))),
            ]));
  }
}

class PaymentDetailScreen extends StatefulWidget {
  const PaymentDetailScreen(
      {super.key,
      required this.api,
      required this.payment,
      required this.refresh});
  final FleetApi api;
  final Map<String, dynamic> payment;
  final Future<void> Function() refresh;
  @override
  State<PaymentDetailScreen> createState() => _PaymentDetailScreenState();
}

class _PaymentDetailScreenState extends State<PaymentDetailScreen> {
  Map<String, dynamic>? detail;
  String? error;
  bool busy = false;
  @override
  void initState() {
    super.initState();
    load();
  }

  Future<void> load() async {
    try {
      final d = await widget.api.get('/api/fleet-control/payment-detail',
          queryParameters: {'requestId': widget.payment['id']});
      if (mounted) setState(() => detail = d);
    } catch (e) {
      if (mounted) setState(() => error = readableError(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.payment;
    return Scaffold(
        appBar: AppBar(
            title: Text(text(p['requestNo']).isEmpty
                ? 'Payment detail'
                : text(p['requestNo']))),
        body: detail == null && error == null
            ? const Center(child: CircularProgressIndicator(color: brand))
            : ListView(padding: const EdgeInsets.all(16), children: [
                if (error != null)
                  EmptyCard(
                      icon: Icons.error_outline,
                      title: 'Unable to load detail',
                      message: error!),
                Card(
                    child: Padding(
                        padding: const EdgeInsets.all(16),
                        child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(children: [
                                Expanded(
                                    child: Text(currency(p['amount']),
                                        style: const TextStyle(
                                            fontSize: 28,
                                            fontWeight: FontWeight.w900))),
                                StatusPill(status: text(p['status']))
                              ]),
                              const SizedBox(height: 10),
                              _DetailLine('Payment head', text(p['head'])),
                              _DetailLine('Station', text(p['stationCode'])),
                              _DetailLine(
                                  'Requested by', text(p['requestedBy'])),
                              _DetailLine(
                                  'Work date', formatDate(text(p['workDate']))),
                              _DetailLine('Requested',
                                  formatDate(text(p['requestedAt']))),
                              if (text(p['remarks']).isNotEmpty)
                                _DetailLine('Remarks', text(p['remarks']))
                            ]))),
                if (detail != null) ...[
                  const SizedBox(height: 16),
                  const SectionTitle(title: 'Request details'),
                  const SizedBox(height: 8),
                  if ((detail!['answers'] as List? ?? []).isEmpty)
                    const Text('No additional answers supplied.',
                        style: TextStyle(color: Color(0xff687386))),
                  ...(detail!['answers'] as List? ?? []).whereType<Map>().map(
                      (a) => Card(
                          margin: const EdgeInsets.only(bottom: 7),
                          child: ListTile(
                              title: Text(text(a['label']),
                                  style: const TextStyle(
                                      fontWeight: FontWeight.w700)),
                              subtitle: Text(text(a['value']))))),
                  if ((detail!['attachments'] as List? ?? []).isNotEmpty) ...[
                    const SizedBox(height: 12),
                    const SectionTitle(title: 'Attachments'),
                    ...(detail!['attachments'] as List).whereType<Map>().map(
                        (a) => Card(
                            margin: const EdgeInsets.only(top: 7),
                            child: ListTile(
                                leading: const Icon(Icons.attach_file),
                                title: Text(text(a['label'])),
                                subtitle: Text(text(a['fileName'])))))
                  ],
                  const SizedBox(height: 16),
                  const SectionTitle(title: 'Approval history'),
                  const SizedBox(height: 8),
                  ...(detail!['history'] as List? ?? []).whereType<Map>().map(
                      (h) => Card(
                          margin: const EdgeInsets.only(bottom: 7),
                          child: ListTile(
                              leading: StatusIcon(
                                  status: text(h['action']),
                                  icon: Icons.history),
                              title: Text(
                                  '${titleCase(text(h['action']))} · ${text(h['actor'])}',
                                  style: const TextStyle(
                                      fontWeight: FontWeight.w700)),
                              subtitle: Text(
                                  '${text(h['role'])}${text(h['comments']).isEmpty ? '' : '\n${text(h['comments'])}'}\n${formatDate(text(h['createdAt']))}'))))
                ],
                const SizedBox(height: 90)
              ]),
        bottomNavigationBar: p['canApprove'] == true
            ? SafeArea(
                child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Row(children: [
                      Expanded(
                          child: OutlinedButton(
                              onPressed: busy ? null : () => act('return'),
                              style: OutlinedButton.styleFrom(
                                  minimumSize: const Size.fromHeight(52)),
                              child: const Text('Return'))),
                      const SizedBox(width: 9),
                      Expanded(
                          child: FilledButton(
                              onPressed: busy ? null : () => act('approve'),
                              style: FilledButton.styleFrom(
                                  backgroundColor: const Color(0xff087f5b),
                                  minimumSize: const Size.fromHeight(52)),
                              child: Text(busy ? 'Updating…' : 'Approve')))
                    ])))
            : null);
  }

  Future<void> act(String action) async {
    final note = TextEditingController();
    final ok = action == 'approve'
        ? true
        : await showDialog<bool>(
                context: context,
                builder: (c) => AlertDialog(
                        title: const Text('Return for correction'),
                        content: TextField(
                            controller: note,
                            maxLines: 3,
                            decoration:
                                const InputDecoration(labelText: 'Reason *')),
                        actions: [
                          TextButton(
                              onPressed: () => Navigator.pop(c, false),
                              child: const Text('Cancel')),
                          FilledButton(
                              onPressed: () =>
                                  Navigator.pop(c, note.text.trim().isNotEmpty),
                              child: const Text('Return'))
                        ])) ??
            false;
    if (!ok) return;
    setState(() => busy = true);
    try {
      await widget.api.post('/api/fleet-control/payment-action', {
        'action': action,
        'requestId': widget.payment['id'],
        'status': widget.payment['status'],
        'comments': action == 'approve'
            ? 'Approved from DropX Fleet mobile'
            : note.text.trim()
      });
      await widget.refresh();
      if (mounted) {
        showMessage(
            context,
            action == 'approve'
                ? 'Payment approved.'
                : 'Returned for correction.');
        Navigator.pop(context);
      }
    } catch (e) {
      if (mounted) showMessage(context, readableError(e));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }
}

class _DetailLine extends StatelessWidget {
  const _DetailLine(this.label, this.value);
  final String label, value;
  @override
  Widget build(BuildContext context) => Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        SizedBox(
            width: 105,
            child:
                Text(label, style: const TextStyle(color: Color(0xff687386)))),
        Expanded(
            child: Text(value.isEmpty ? '—' : value,
                style: const TextStyle(fontWeight: FontWeight.w700)))
      ]));
}

class EnhancedTrackingScreen extends StatefulWidget {
  const EnhancedTrackingScreen({super.key, required this.snapshot});
  final FleetSnapshot snapshot;
  @override
  State<EnhancedTrackingScreen> createState() => _EnhancedTrackingScreenState();
}

class _EnhancedTrackingScreenState extends State<EnhancedTrackingScreen> {
  String query = '';
  int filter = 0;
  @override
  Widget build(BuildContext context) {
    final gps = {
      for (final g in widget.snapshot.summaryList('gpsLive'))
        text(g['vehicle_no']): g
    };
    final metrics = widget.snapshot.summaryList('vehicleMetrics');
    final rows = metrics.where((m) {
      final live = gps[text(m['vehicle_no'])];
      final moving = number(live?['speed']) > 0;
      final ignition = live?['ignition'] == true;
      final match = '${m['vehicle_no']} ${m['station_code']} ${m['model']}'
          .toLowerCase()
          .contains(query.toLowerCase());
      return match &&
          (filter == 0 ||
              filter == 1 && moving ||
              filter == 2 && ignition ||
              filter == 3 && !moving && !ignition);
    }).toList();
    return Scaffold(
        appBar: AppBar(title: const Text('Live tracking')),
        body: ListView(padding: const EdgeInsets.all(16), children: [
          PageHeader(
              eyebrow: 'WHEELSEYE LIVE',
              title: 'Vehicle movement',
              subtitle: 'Speed, distance and start location from live GPS'),
          const SizedBox(height: 14),
          TextField(
              onChanged: (v) => setState(() => query = v),
              decoration: const InputDecoration(
                  prefixIcon: Icon(Icons.search),
                  hintText: 'Search vehicle or station')),
          const SizedBox(height: 9),
          SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: SegmentedButton<int>(segments: const [
                ButtonSegment(value: 0, label: Text('All')),
                ButtonSegment(value: 1, label: Text('Moving')),
                ButtonSegment(value: 2, label: Text('Ignition')),
                ButtonSegment(value: 3, label: Text('Parked'))
              ], selected: {
                filter
              }, onSelectionChanged: (v) => setState(() => filter = v.first))),
          const SizedBox(height: 14),
          ...rows.map((m) {
            final live = gps[text(m['vehicle_no'])];
            final speed = number(live?['speed']);
            final moving = speed > 0;
            return Card(
                margin: const EdgeInsets.only(bottom: 9),
                child: ExpansionTile(
                    leading: StatusIcon(
                        status: moving ? 'active' : 'inactive',
                        icon: moving
                            ? Icons.navigation_rounded
                            : Icons.local_parking_rounded),
                    title: Text(text(m['vehicle_no']),
                        style: const TextStyle(fontWeight: FontWeight.w900)),
                    subtitle: Text(
                        '${text(m['station_code'])} · ${text(m['model'])}'),
                    trailing: Text('${speed.round()} km/h',
                        style: TextStyle(
                            fontWeight: FontWeight.w900,
                            color: moving
                                ? const Color(0xff087f5b)
                                : const Color(0xff687386))),
                    children: [
                      Padding(
                          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                          child: Column(children: [
                            _TrackingRow('Today distance',
                                '${number(m['todayKm']).toStringAsFixed(1)} km'),
                            _TrackingRow('Started moving',
                                _time(text(m['firstMovingAt']))),
                            _TrackingRow('Moving time',
                                '${number(m['todayMovingMinutes']).round()} min'),
                            _TrackingRow('Maximum speed',
                                '${number(m['todayMaxSpeed']).round()} km/h'),
                            _TrackingRow('Last GPS update',
                                _time(text(live?['gps_time']))),
                            if (live != null)
                              _TrackingRow('Coordinates',
                                  '${number(live['latitude']).toStringAsFixed(5)}, ${number(live['longitude']).toStringAsFixed(5)}')
                          ]))
                    ]));
          }),
          if (rows.isEmpty)
            const EmptyCard(
                icon: Icons.location_off_outlined,
                title: 'No vehicle matches',
                message: 'Change the live status filter or search.')
        ]));
  }

  String _time(String v) {
    final d = DateTime.tryParse(v)?.toLocal();
    return d == null ? '—' : DateFormat('d MMM, h:mm a').format(d);
  }
}

class _TrackingRow extends StatelessWidget {
  const _TrackingRow(this.label, this.value);
  final String label, value;
  @override
  Widget build(BuildContext context) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(children: [
        Expanded(
            child:
                Text(label, style: const TextStyle(color: Color(0xff687386)))),
        Text(value, style: const TextStyle(fontWeight: FontWeight.w800))
      ]));
}

class EnhancedFuelScreen extends StatefulWidget {
  const EnhancedFuelScreen({super.key, required this.snapshot});
  final FleetSnapshot snapshot;
  @override
  State<EnhancedFuelScreen> createState() => _EnhancedFuelScreenState();
}

class _EnhancedFuelScreenState extends State<EnhancedFuelScreen> {
  String source = 'ALL';
  String period = 'MTD';
  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    final all = widget.snapshot.summaryList('fuel');
    final rows = all.where((f) {
      final s = text(f['source']).toUpperCase();
      final sourceOk = source == 'ALL' || s.contains(source);
      final d = DateTime.tryParse(text(f['transaction_at']))?.toLocal();
      if (d == null) return false;
      final start = period == 'TODAY'
          ? DateTime(now.year, now.month, now.day)
          : period == '7D'
              ? now.subtract(const Duration(days: 7))
              : period == 'YTD'
                  ? DateTime(now.year)
                  : DateTime(now.year, now.month);
      return sourceOk && !d.isBefore(start);
    }).toList();
    final metrics = {
      for (final m in widget.snapshot.summaryList('vehicleMetrics'))
        text(m['vehicle_no']): m
    };
    final grouped = <String, List<Map<String, dynamic>>>{};
    for (final r in rows)
      grouped
          .putIfAbsent(
              text(r['station_code']).isEmpty
                  ? 'UNMAPPED'
                  : text(r['station_code']),
              () => [])
          .add(r);
    final litres = rows.fold<double>(0, (s, r) => s + number(r['quantity']));
    final amount = rows.fold<double>(0, (s, r) => s + number(r['amount']));
    return Scaffold(
        appBar: AppBar(title: const Text('Fuel')),
        body: ListView(padding: const EdgeInsets.all(16), children: [
          const PageHeader(
              eyebrow: 'FUEL CONTROL',
              title: 'Fuel analytics',
              subtitle: 'Station and vehicle efficiency from all fuel sources'),
          const SizedBox(height: 14),
          SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: SegmentedButton<String>(segments: const [
                ButtonSegment(value: 'ALL', label: Text('All')),
                ButtonSegment(value: 'IOC', label: Text('IOCL')),
                ButtonSegment(value: 'BPC', label: Text('BPCL')),
                ButtonSegment(value: 'PAY', label: Text('PayTap'))
              ], selected: {
                source
              }, onSelectionChanged: (v) => setState(() => source = v.first))),
          const SizedBox(height: 9),
          SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: SegmentedButton<String>(segments: const [
                ButtonSegment(value: 'TODAY', label: Text('Today')),
                ButtonSegment(value: '7D', label: Text('7 days')),
                ButtonSegment(value: 'MTD', label: Text('MTD')),
                ButtonSegment(value: 'YTD', label: Text('YTD'))
              ], selected: {
                period
              }, onSelectionChanged: (v) => setState(() => period = v.first))),
          const SizedBox(height: 14),
          Row(children: [
            Expanded(
                child: _FuelMetric(
                    'Spend', currency(amount), const Color(0xffd97706))),
            const SizedBox(width: 9),
            Expanded(
                child: _FuelMetric('Fuel', '${litres.toStringAsFixed(1)} L',
                    const Color(0xff087f5b))),
            const SizedBox(width: 9),
            Expanded(child: _FuelMetric('Entries', '${rows.length}', ink))
          ]),
          const SizedBox(height: 18),
          const SectionTitle(title: 'Station summary'),
          const SizedBox(height: 8),
          ...grouped.entries.map((entry) {
            final stationAmount =
                entry.value.fold<double>(0, (s, r) => s + number(r['amount']));
            final stationLitres = entry.value
                .fold<double>(0, (s, r) => s + number(r['quantity']));
            final vehicles = <String, List<Map<String, dynamic>>>{};
            for (final r in entry.value)
              vehicles.putIfAbsent(text(r['vehicle_no']), () => []).add(r);
            return Card(
                margin: const EdgeInsets.only(bottom: 9),
                child: ExpansionTile(
                    title: Text(entry.key,
                        style: const TextStyle(fontWeight: FontWeight.w900)),
                    subtitle: Text(
                        '${vehicles.length} vehicles · ${stationLitres.toStringAsFixed(1)} L'),
                    trailing: Text(currency(stationAmount),
                        style: const TextStyle(fontWeight: FontWeight.w900)),
                    children: vehicles.entries.map((v) {
                      final vLitres = v.value
                          .fold<double>(0, (s, r) => s + number(r['quantity']));
                      final vAmount = v.value
                          .fold<double>(0, (s, r) => s + number(r['amount']));
                      final km = number(metrics[v.key]?['km']);
                      return ListTile(
                          title: Text(v.key,
                              style:
                                  const TextStyle(fontWeight: FontWeight.w800)),
                          subtitle: Text(
                              '${v.value.length} transactions · ${vLitres.toStringAsFixed(1)} L · ${km.toStringAsFixed(0)} km'),
                          trailing: Column(
                              mainAxisAlignment: MainAxisAlignment.center,
                              crossAxisAlignment: CrossAxisAlignment.end,
                              children: [
                                Text(currency(vAmount),
                                    style: const TextStyle(
                                        fontWeight: FontWeight.w800)),
                                Text(
                                    vLitres > 0
                                        ? '${(km / vLitres).toStringAsFixed(1)} km/L'
                                        : '—',
                                    style: const TextStyle(
                                        fontSize: 12, color: Color(0xff687386)))
                              ]));
                    }).toList()));
          }),
          if (grouped.isEmpty)
            const EmptyCard(
                icon: Icons.local_gas_station_outlined,
                title: 'No fuel entries',
                message: 'No transaction matches this source and period.')
        ]));
  }
}

class _FuelMetric extends StatelessWidget {
  const _FuelMetric(this.label, this.value, this.color);
  final String label, value;
  final Color color;
  @override
  Widget build(BuildContext context) => Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
          color: color.withValues(alpha: .08),
          borderRadius: BorderRadius.circular(13)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(label,
            style: const TextStyle(fontSize: 11, color: Color(0xff687386))),
        const SizedBox(height: 4),
        FittedBox(
            child: Text(value,
                style: TextStyle(
                    fontWeight: FontWeight.w900, color: color, fontSize: 17)))
      ]));
}
