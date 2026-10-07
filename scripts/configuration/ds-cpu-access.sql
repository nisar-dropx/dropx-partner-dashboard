-- One-time, user-requested configuration. Editable afterward in OpsPulse Users & Access.
-- CPU view is independent of LM CPS and grants no unit editing, payroll or Finance access.
BEGIN;
INSERT INTO app_pages (company_id,code,name,sort_order,is_active)
VALUES ('43866344-b550-4e8a-9a2d-9d23f3d8a997','cpu_overview','CPU · Dark Store',74,true)
ON CONFLICT (company_id,code) DO UPDATE SET name=excluded.name,is_active=true;
INSERT INTO role_page_permissions (company_id,role_id,page_id,can_view,can_add,can_edit)
SELECT r.company_id,r.id,p.id,true,false,false
FROM user_roles r
JOIN app_pages p ON p.company_id=r.company_id AND p.code='cpu_overview'
WHERE r.company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997' AND r.is_active
AND (r.code='OPERATIONS_LOCATION' OR EXISTS (
 SELECT 1 FROM role_page_permissions g JOIN app_pages source ON source.id=g.page_id
 WHERE g.company_id=r.company_id AND g.role_id=r.id AND source.code='cps_overview' AND (g.can_view OR g.can_add OR g.can_edit)
))
ON CONFLICT (company_id,role_id,page_id) DO UPDATE SET can_view=true,updated_at=now();
COMMIT;
