#!/bin/sh
# 커밋 단계에서 막을 생성 도구 흔적 패턴.
# 이 파일 자신이 걸리지 않도록 각 단어를 문자 클래스로 쪼개 적는다.
ROBOT=$(printf '\360\237\244\226')
TRACE_RE="[Cc]o-[Aa]uthored-[Bb]y|[Gg]enerated (with|by) [A-Za-z]|[Cc][Ll][Aa][Uu][Dd][Ee]|[Aa][Nn][Tt][Hh][Rr][Oo][Pp][Ii][Cc]|${ROBOT}"
