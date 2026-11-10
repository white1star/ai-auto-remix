# -*- coding: utf-8 -*-
"""把文案里的阿拉伯数字/百分号/常见符号转成中文读法，再喂给 F5。
中文零样本 TTS 直接吃 "100块" "85%" "1.5公分" 容易念糊或蹦英文，
先归一化成「一百块」「百分之八十五」「一点五公分」就稳了。"""
import re

DIGITS = "零一二三四五六七八九"


def _int2cn(n):
    if n == 0:
        return "零"
    units = ["", "十", "百", "千", "万", "十", "百", "千", "亿"]
    s = str(n)
    out, zero = [], False
    for i, ch in enumerate(s):
        d = int(ch)
        pos = len(s) - i - 1
        if d == 0:
            zero = True
        else:
            if zero and out:
                out.append("零")
            zero = False
            out.append(DIGITS[d] + units[pos])
    t = "".join(out)
    # 「一十五」→「十五」
    if t.startswith("一十"):
        t = t[1:]
    return t.rstrip("零") or "零"


def _num2cn(tok):
    if "." in tok:
        a, b = tok.split(".", 1)
        return _int2cn(int(a)) + "点" + "".join(DIGITS[int(c)] for c in b if c.isdigit())
    return _int2cn(int(tok))


def normalize(text, expand_latin=False):
    """expand_latin: 把连续英文缩写拆成单字母（XRT → X R T）。
    实测粘连的 XRT 会整段被吞掉，拆开后能念出来；单个字母（X射线）不受影响。"""
    t = str(text)
    # 40%+ → 百分之四十以上（"以上"比"加"更符合口播习惯），必须在百分号规则之前
    t = re.sub(r"[%％]\s*\+", "％以上", t)
    # 3-5倍 → 3到5倍（只认单个数字，避免把 2026-01-01 这类日期拆烂）
    t = re.sub(r"(?<!\d)(\d)\s*[-–—~～]\s*(\d)(?!\d)", r"\1到\2", t)
    if expand_latin:
        t = re.sub(r"(?<![A-Za-z])([A-Za-z]{2,})(?![A-Za-z])",
                   lambda m: " ".join(m.group(1)), t)
    # 85% → 百分之八十五（先处理百分号，避免数字先被转掉）
    t = re.sub(r"(\d+(?:\.\d+)?)\s*[%％]", lambda m: "百分之" + _num2cn(m.group(1)), t)
    # 剩下的数字
    t = re.sub(r"\d+(?:\.\d+)?", lambda m: _num2cn(m.group(0)), t)
    # 常见符号读法
    t = t.replace("℃", "摄氏度").replace("°C", "摄氏度")
    t = t.replace("+", "加").replace("~", "到").replace("～", "到")
    t = re.sub(r"[—–\-]{2,}", "，", t)
    # 去掉不会念的装饰符号，避免模型硬读
    t = re.sub(r"[#@&*_/\\|<>\[\]{}^`$]", "", t)
    return t


if __name__ == "__main__":
    import sys
    for s in sys.argv[1:] or ["吨选矿成本超100块，回收率85%以上，1.5公分以上矿石，850度密闭煅烧"]:
        print(normalize(s))
