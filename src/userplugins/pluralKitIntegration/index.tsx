/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addPreEditListener, removePreEditListener } from "@api/MessageEvents";
import { addButton, removeButton } from "@api/MessagePopover";
import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { useAwaiter } from "@utils/react";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, GuildMemberStore, MessageActions, MessageStore, UserStore } from "@webpack/common";
import type { Message, User } from "discord-types/general";

import { hexStringToHSL, hslToHexString } from "./color";
import { PencilIcon } from "@components/Icons";


// Inspired By:
//  - PluralChum
//  - Scyye's pluralkit + vencord plugin

// Cobbled together through intense googling and trial and error + frustration
// (I'm very much not a JS/TS or frontend dev)

// Features:
// - Adds an edit button to proxied messages, allowing them to be edited like normal
// - Colors member names with either member color, system color, or account role color
// - Replaces the "APP" (formerly "BOT") tag with "PK"
// - Adds some member info to the profile popup

// Known Issues:
// - pk edit button doesn't quite match normal discord
// - seems to conflict with showMeYourName, which makes sense because the patch is basically the same
// - conflicts with moreUserTags in that moreUserTags overwrites the "PK" tag with "WEBHOOK"
// - profile popups still have an "add notes" box that doesn't work
// - "APP" tag is still shown in profile popups

// Future Ideas:
// - Delete message confirmation modal + shift to skip (to match normal messages)
// - Re-add delete button (removed since findByPropsLazy died and I couldn't figure it out)
// - Re-add "none" color mode
// - Improve member popup (add more info, "APP" -> "PK")

const PLURALKIT_BOT_ID = "466378653216014359";

// the pk badge is hardcoded to be tag type 237
// why? uh, discord uses up to ~8, moreUserTags uses 100-1XX
// hopefully nobody else tries to pick 237
// This Is Very Good Code :tm: /s
const PK_BADGE_ID = 237;

const colorsToGet = new Array<Message>();
const ownMembers = new Set<AuthorID>();
const authorColors = new Map<AuthorID, NameColor>();
const cachedPkMemberInfo = new Map<MemberID, any>(); // pk member objects

const logger = new Logger("PluralKitIntegration");

const settings = definePluginSettings({
    colorMode: {
        description: "Color Mode",
        type: OptionType.SELECT,
        options: [
            { label: "Color by account role color", value: "Account", default: true },
            { label: "Color by member color", value: "Member" },
            { label: "Color by system color", value: "System" },
            // { label: "No color", value: "None" } // disabled since it breaks member profiles because of my own bad code
        ],
        restartNeeded: true, // to update previously rendered names
        onChange(_: any) {
            authorColors.clear();
        }
    },
    readableColors: {
        description: "Adjust Member/System colors for readability",
        type: OptionType.BOOLEAN,
        default: false,
        restartNeeded: true,
        onChange(_: any) {
            authorColors.clear();
        }
    },
    enableTag: {
        description: "Replace \"APP\" tag with \"PK\" (conflicts with MoreUserTags)",
        type: OptionType.BOOLEAN,
        default: true,
        restartNeeded: true
    },
    enableButtons: {
        description: "Add Edit and Delete buttons on proxied messages",
        type: OptionType.BOOLEAN,
        default: true,
        restartNeeded: false
    }
});


// noinspection JSUnusedGlobalSymbols
export default definePlugin({
    settings,
    name: "PluralKitIntegration",
    description: "Makes PluralKit slightly less painful to use",
    dependencies: ["MessageEventsAPI"], // is this needed?
    authors: [
        {
            id: 951258605615718410n,
            name: "Lynxize"
        }
    ],
    patches: [
        // color usernames in chat
        {
            // todo: conflicts with showMeYourName
            find: '?"@":""',
            replacement: {
                match: /(?<=onContextMenu:\i,children:).*?\)}/,
                replace: "$self.renderUsername(arguments[0])}"
            }
        },
        // make up arrow to edit most recent message work
        // this might conflict with messageLogger, but to be honest, if you're
        // using that plugin, you'll have enough problems with pk already
        {
            find: "getLastEditableMessage",
            replacement: {
                match: /return (.)\(\)\(this.getMessages\((.)\).{10,100}:.\.id\)/,
                replace: "return $1()(this.getMessages($2).toArray()).reverse().find(msg => $self.isOwnMessage(msg)"
            }
        },
        // if a message is proxied, forcibly change the tag type to pk
        // this patch is kind of nasty, but I'm terrible wtih regex
        {
            predicate: () => settings.store.enableTag,
            find: "isSystemDM())?",
            replacement: {
                match: /null!=(.)&&\(0,(.{0,200})\.bot\)\?(.)=.\..\.Types.BOT/,
                replace: "null!=$1&&(0,$2.bot)?$3=$self.changeBotBadge($1)"
            }
        },
        // displays the injected tag type as "PK"
        {
            predicate: () => settings.store.enableTag,
            find: "DISCORD_SYSTEM_MESSAGE_BOT_TAG_TOOLTIP_OFFICIAL,",
            replacement: {
                match: /case (.\..{0,5})\.SERVER:(.)=/,
                replace: "case " + PK_BADGE_ID + ":$2=\"PK\";break;case $1.SERVER:$2="
            }
        }
    ],

    changeBotBadge: (message: Message) => isPkProxiedMessage(message) ? PK_BADGE_ID : 0, // 0 is bot tag id
    isPluralKitProfile: (user: User) => cachedPkMemberInfo[getPkMemberID(user)] != null,
    isOwnMessage: (message: Message) => isOwnPkMessage(message) || message.author.id === UserStore.getCurrentUser().id,

    renderUsername: ({ author, message, withMentionPrefix }) => useAwaiter(async () => {
        if (!isPkProxiedMessage(message) || settings.store.colorMode === "None")
            return <>{withMentionPrefix ? "@" : ""}{author?.nick}</>;

        const authorId = getAuthorID(message)!!;
        let color: NameColor = authorColors[authorId];
        if (!color || color.expires < Date.now()) colorsToGet.push(message);

        while (!color) {
            // wait around until it gets around to fetching the color we want
            await sleep(300);
            color = authorColors[authorId];
        }

        return <span style={{ color: color.color }}>
            {withMentionPrefix ? "@" : ""}{author.nick}
        </span>;

    }, { fallbackValue: <>{withMentionPrefix ? "@" : ""}{author?.nick}</> }),


    start() {
        // noinspection JSIgnoredPromiseFromCall
        fetchColors();
        setInterval(clearExpiredColors, 1000 * 60 * 5);

        addButton("PkEdit", msg => {
            if (!settings.store.enableButtons || !msg || !isOwnPkMessage(msg)) return null;
            else return {
                label: "Edit (PK)",
                icon: PencilIcon,
                message: msg,
                channel: ChannelStore.getChannel(msg.channel_id),
                onClick: () => MessageActions.startEditMessage(msg.channel_id, msg.id, msg.content),
                onContextMenu: _ => {
                }
            };
        });

        this.preEditListener = addPreEditListener((channelId, messageId, messageObj) => {
            if (isPkProxiedMessage(MessageStore.getMessage(channelId, messageId))) {
                const { guild_id } = ChannelStore.getChannel(channelId);
                MessageActions.sendMessage(channelId, {
                    reaction: false,
                    content: "pk;e https://discord.com/channels/" + guild_id + "/" + channelId + "/" + messageId + " " + messageObj.content
                });
                // return {cancel: true}
                // note that presumably we're sending off invalid edit requests, hopefully that doesn't cause issues
                // todo: look into closing the edit box without sending a bad edit request to discord
            }
        });
    },

    stop() {
        removeButton("PkEdit");
        removePreEditListener(this.preEditListener);
    }
});

// this loops forever, getting colors as fast as we can without running
// into the pk api ratelimit of ~~2~~ (now 10) requests per second
// there are smarter ways to do this!
async function fetchColors() {
    // noinspection InfiniteLoopJS
    while (true) {
        if (colorsToGet.length === 0) {
            await sleep(500);
            continue;
        }

        const messageInfo = colorsToGet.pop()!!;
        const authorId = getAuthorID(messageInfo);

        // something went wrong... this happens so rarely in practice that its not worth handling
        // the point is to not stop this loop, and I don't want to wrap the whole thing in a try block
        if(!authorId) continue;

        const existing = authorColors[authorId];
        if (existing && existing.expires > Date.now()) continue; // unexpired one exists, skip

        let json: any;
        try {
            const request = await fetch("https://api.pluralkit.me/v2/messages/" + messageInfo.id);
            json = await request.json();
        } catch (e) {
            console.log(e);
            // wait a bit before trying again
            colorsToGet.push(messageInfo);
            await sleep(5000);
            continue;
        }

        const { colorMode, readableColors } = settings.store;
        let color = "#666666"; // placeholder color

        if (colorMode === "Member") color = "#" + json.member?.color;
        else if (colorMode === "System") color = "#" + json.system?.color;
        else if (colorMode === "Account") {
            const account = GuildMemberStore.getMember(
                ChannelStore.getChannel(messageInfo.getChannelId()).getGuildId(),
                json.sender
            );
            color = account?.colorString ?? color;
        }

        if (readableColors && (colorMode === "Member" || colorMode === "System")) {
            // todo: this assumes a dark theme
            const [h, s, l] = hexStringToHSL(color);
            color = hslToHexString([h, s, Math.max(l, 70)]);
        }

        authorColors[authorId] = {
            color: color,
            expires: Date.now() + 120 * 1000,
        }; // expires two minutes from now

        cachedPkMemberInfo[getPkMemberIDFromAuthorID(authorId)] = json.member;
        if (json.sender === UserStore.getCurrentUser().id) ownMembers.add(authorId);

        await sleep(100); // we don't want to do more than 10 requests per second
    }
}


// Every once in a while we need to get rid of expired color entries
// just to prevent them growing infinitely
async function clearExpiredColors() {
    let num = 0;
    const now = Date.now();
    for (const authorId in authorColors.keys()) {
        if (authorColors[authorId].expires < now) {
            authorColors.delete(authorId);
            cachedPkMemberInfo.delete(getPkMemberIDFromAuthorID(authorId)); // also remove from saved pk members
            num++;
        }
    }
    logger.info("Cleared " + num + " expired colors");
}


function isOwnPkMessage(message: Message): boolean {
    return ownMembers.has(getAuthorID(message)!!);
}

function isPkProxiedMessage(message: Message): boolean {
    return message && message.applicationId === PLURALKIT_BOT_ID && message.webhookId !== undefined;
}

async function sleep(millis: number) {
    await new Promise(r => setTimeout(r, millis));
}

// provides a way to differentiate between pk users without touching the pk api
// includes channel id so that the same member in different servers isn't considered to be the same
// since the account's role color might be different
function getAuthorID(message: Message): AuthorID | null {
    return message.author.username + message.author.avatar + " " + message.getChannelId();
}

// this does return a perfectly valid thing for non-pk users so be careful
// like the author id but without the channel id
function getPkMemberID(user: User): MemberID {
    return user.username + user.avatar;
}

function getPkMemberIDFromAuthorID(author: AuthorID): MemberID {
    const a = author.split(" ");
    a.pop(); // removes channel id
    return a.join(" ");
}

type AuthorID = string;
type MemberID = string; // **NOT** a 5-6 char pk member id

type NameColor = {
    expires: number;
    color: string;
};
