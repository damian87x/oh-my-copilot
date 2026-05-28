# GitHub Permalinks

When the research is on `main`/`master` or the commit is pushed, replace local file references with GitHub permalinks.

## Get repo info

```bash
gh repo view --json owner,name --jq '"\(.owner.login)/\(.name)"'
```

## Permalink format

```
https://github.com/{owner}/{repo}/blob/{commit}/{file}#L{line}
```

For line ranges:
```
https://github.com/{owner}/{repo}/blob/{commit}/{file}#L{start}-L{end}
```

## When to use

- Only when on `main`/`master` or the commit is known to be pushed
- Replace `path/to/file.ts:42` with the full permalink
- Keep the local path as descriptive text: `[path/to/file.ts:42](permalink)`
