#!/usr/bin/env python3
"""Size breakdown of a GLB: images, animations, mesh base attributes, morph targets (sparse or not)."""
import json, struct, sys, collections
data = open(sys.argv[1], "rb").read()
jlen = struct.unpack_from("<I", data, 12)[0]
g = json.loads(data[20:20 + jlen])
bv = g["bufferViews"]; acc = g["accessors"]
size = lambda a: bv[a["bufferView"]]["byteLength"] if "bufferView" in a else 0
def asize(i):
    a = acc[i]; s = size(a)
    if "sparse" in a: s += bv[a["sparse"]["indices"]["bufferView"]]["byteLength"] + bv[a["sparse"]["values"]["bufferView"]]["byteLength"]
    return s
tot = collections.Counter()
for m in g["meshes"]:
    for p in m["primitives"]:
        for k, i in p["attributes"].items(): tot[f"mesh {m['name']} base"] += asize(i)
        tot[f"mesh {m['name']} base"] += asize(p["indices"]) if "indices" in p else 0
        for t in p.get("targets", []):
            for k, i in t.items():
                tot[f"mesh {m['name']} morph {k}{' (sparse)' if 'sparse' in acc[i] else ''}"] += asize(i)
seen = set()
for a in g.get("animations", []):
    for s in a["samplers"]:
        for i in (s["input"], s["output"]):
            if i not in seen: seen.add(i); tot["animations"] += asize(i)
for im in g.get("images", []): tot[f"image {im.get('name')}"] += bv[im["bufferView"]]["byteLength"]
for k, v in sorted(tot.items(), key=lambda x: -x[1]): print(f"{v/1e6:7.2f} MB  {k}")
print(f"{len(data)/1e6:7.2f} MB  TOTAL")
