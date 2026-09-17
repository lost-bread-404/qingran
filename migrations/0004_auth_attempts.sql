-- 登录失败计数：serverless 实例之间不共享内存，所以放数据库。
create table if not exists auth_attempts (
  ip text primary key,
  fails int not null default 0,
  window_start bigint not null
);
