-- Story-line rows become kind=seed. Exact ids and topics from seed/story.json only.
update qr_portrait
set kind = 'seed', status = 'active'
where id in (
  'p:qingran', 'p:rosie', 'p:linze', 'p:world', 'p:cycle',
  'p:system', 'p:bond', 'p:home', 'p:stance', 'p:names'
)
or topic in (
  '清然', 'Rosie', '林泽', '世界观', '周期', '匹配系统', '关系', '住所', '相处方式', '称呼'
);

-- Confirmed event cleanup: stale, never delete. Seeds are already marked and skipped.
-- Rows that only lack two evidence dates are left alone.
update qr_portrait
set status = 'stale'
where kind is distinct from 'seed'
  and status = 'active'
  and (
    kind = 'episode'
    or topic in ('整夜陪伴承诺', '整夜陪伴', '噩梦安抚', '任务激励与主导', '林泽前的占有展示')
    or topic like '%承诺%' or body like '%承诺%'
    or topic like '%安抚%' or body like '%安抚%'
    or topic like '%占有展示%' or body like '%占有展示%'
    or topic like '%今晚%' or body like '%今晚%'
    or topic like '%这一次%' or body like '%这一次%'
    or topic like '%那天%' or body like '%那天%'
    or topic like '%噩梦%' or body like '%噩梦%'
  );
