# -*- coding: utf-8 -*-
"""把本地文件推到 GitHub 仓库（走 api.github.com，不依赖 git 与 github.com 主站）。

用法：
  python github_ci/gh_put.py <repo> <branch> <本地路径>=<仓库路径> [<本地路径>=<仓库路径> ...] --msg "提交说明"

token 从环境变量 GH_TOKEN 读取。
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.request

API = 'https://api.github.com'


def call(method, path, token, payload=None):
    data = json.dumps(payload).encode('utf-8') if payload is not None else None
    req = urllib.request.Request(API + path, data=data, method=method, headers={
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'san-tai-gh-put',
    })
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return r.status, json.loads(r.read().decode('utf-8') or '{}')
    except urllib.error.HTTPError as e:
        body = (e.read() or b'').decode('utf-8', 'ignore')
        return e.code, {'error': body[:400]}


def put_file(repo, branch, local, remote, message, token):
    with open(local, 'rb') as f:
        content = base64.b64encode(f.read()).decode('ascii')
    st, cur = call('GET', '/repos/%s/contents/%s?ref=%s' % (repo, remote, branch), token)
    payload = {'message': message, 'content': content, 'branch': branch}
    action = 'create'
    if st == 200 and isinstance(cur, dict) and cur.get('sha'):
        payload['sha'] = cur['sha']
        action = 'update'
    st2, res = call('PUT', '/repos/%s/contents/%s' % (repo, remote), token, payload)
    if st2 in (200, 201):
        sha = ((res.get('content') or {}).get('sha') or '')[:8]
        print('%-6s %-46s -> %s' % (action, remote, sha or 'ok'))
        return True
    print('FAIL   %-46s %s %s' % (remote, st2, res.get('error', res)))
    return False


def main():
    argv = sys.argv[1:]
    msg = 'sync'
    if '--msg' in argv:
        i = argv.index('--msg')
        msg = argv[i + 1]
        argv = argv[:i] + argv[i + 2:]
    repo, branch = argv[0], argv[1]
    token = os.environ.get('GH_TOKEN') or ''
    if not token:
        sys.exit('缺 GH_TOKEN 环境变量')
    ok = True
    for pair in argv[2:]:
        local, remote = pair.split('=', 1)
        ok = put_file(repo, branch, local, remote, msg, token) and ok
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
