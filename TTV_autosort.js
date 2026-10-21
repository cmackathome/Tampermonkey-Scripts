// ==UserScript==
// @name         Twitch Auto Sort by Viewer Count
// @namespace    https://tampermonkey.net/
// @version      2.0
// @description  Automatically forces Twitch directory and category pages to sort by Viewers (High to Low)
// @author       You
// @match        https://www.twitch.tv/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // Set to true so if you intentionally choose another sort (e.g. Low to High),
    // the script won't fight you on the same page. It will auto-sort again when you navigate to a new page.
    const RESPECT_MANUAL_CHANGES = true;

    const STORAGE_KEYS = [
        'browseAllCategoriedPageSort',
        'directoryAllChannelPageSort',
        'directoryGameChannelPageSort'
    ];

    // Keep Twitch's internal storage preference primed
    function syncStorage() {
        for (const key of STORAGE_KEYS) {
            try {
                localStorage.setItem(key, JSON.stringify('VIEWER_COUNT'));
                sessionStorage.setItem(key, JSON.stringify('VIEWER_COUNT'));
            } catch (_) {}
        }
    }
    syncStorage();

    function isDirectoryPage() {
        const path = window.location.pathname;
        if (!path.startsWith('/directory')) return false;
        // Don't interfere with clips or videos sub-tabs
        if (path.includes('/clips') || path.includes('/videos') || path.includes('/details')) return false;
        return true;
    }

    function findSortButton() {
        // 1. Direct attribute selectors
        const targeted = document.querySelector(
            'div[data-a-target="sort-and-filter"] button, ' +
            'button[data-a-target="sort-and-filter"], ' +
            '[data-a-target="sort-by-dropdown"] button, ' +
            '[data-test-selector="sort-by"] button, ' +
            'button[id*="dropdown-sort"]'
        );
        if (targeted) return targeted;

        // 2. Any listbox trigger on directory pages (Twitch uses aria-haspopup="listbox" for sort menus)
        const listboxButtons = document.querySelectorAll('button[aria-haspopup="listbox"], div[role="combobox"] button');
        for (const btn of listboxButtons) {
            if (btn.closest('[data-a-target="tag-filter-dropdown"]')) continue;
            return btn;
        }

        // 3. Fallback: inspect buttons in the main directory toolbar
        const buttons = document.querySelectorAll('main button, [role="main"] button');
        for (const btn of buttons) {
            const txt = (btn.innerText || btn.textContent || '').trim().toLowerCase();
            if (
                txt.includes('recommended') ||
                txt.includes('relevance') ||
                txt.includes('viewers') ||
                txt.includes('empfohlen') ||
                txt.includes('recommandé') ||
                txt.includes('espectadores')
            ) {
                if (btn.getAttribute('aria-haspopup') || btn.querySelector('svg')) {
                    return btn;
                }
            }
        }

        return null;
    }

    function isAlreadySorted(btn) {
        const txt = (btn.innerText || btn.textContent || '').toLowerCase();
        // If it includes viewers/high to low and not low to high
        const hasViewers = /viewer|high\s*to\s*low|zuschauer|spectateur|espectador|widz/i.test(txt);
        const hasLowToHigh = /low\s*to\s*high|aufsteigend|croissant|menor\s*a\s*mayor/i.test(txt);
        return hasViewers && !hasLowToHigh;
    }

    let isSorting = false;
    let handledUrl = '';

    function trySort() {
        if (!isDirectoryPage()) return false;
        if (isSorting) return false;

        const currentUrl = window.location.href;
        if (RESPECT_MANUAL_CHANGES && handledUrl === currentUrl) {
            return true;
        }

        const sortBtn = findSortButton();
        if (!sortBtn) return false;

        if (isAlreadySorted(sortBtn)) {
            handledUrl = currentUrl;
            return true;
        }

        isSorting = true;

        // Hide the dropdown menu visually for the split-second it takes to click it
        const hideStyle = document.createElement('style');
        hideStyle.id = 'auto-sort-hidden-portal';
        hideStyle.textContent = '[role="listbox"] { opacity: 0 !important; pointer-events: none !important; }';
        document.documentElement.appendChild(hideStyle);

        // Click the sort button to trigger the dropdown
        sortBtn.click();

        // Wait for React to mount the listbox options portal
        let attempts = 0;
        const pollTimer = setInterval(() => {
            attempts++;
            const listbox = document.querySelector('[role="listbox"]');

            if (listbox) {
                clearInterval(pollTimer);
                const options = Array.from(listbox.querySelectorAll('[role="option"], [data-a-target="dropdown-menu-item"]'));

                // Find "Viewers (High to Low)"
                let targetOption = options.find(opt => {
                    const t = (opt.textContent || '').toLowerCase();
                    return (
                        /high\s*to\s*low|viewer|zuschauer|spectateur|espectador|widz/i.test(t) &&
                        !/low\s*to\s*high|aufsteigend|croissant/i.test(t)
                    );
                });

                // Fallback: 2nd option (index 1) is always "Viewers (High to Low)" on Twitch
                if (!targetOption && options.length >= 2) {
                    targetOption = options[1];
                }

                if (targetOption) {
                    targetOption.click();
                } else {
                    sortBtn.click(); // close menu if not found
                }

                hideStyle.remove();
                handledUrl = currentUrl;
                isSorting = false;
                return;
            }

            if (attempts >= 15) { // 750ms timeout
                clearInterval(pollTimer);
                hideStyle.remove();
                isSorting = false;
            }
        }, 50);

        return true;
    }

    // Polling retry because Twitch renders directories asynchronously via React / GraphQL
    let retryInterval = null;
    function triggerSortWithRetry() {
        if (!isDirectoryPage()) return;
        syncStorage();

        if (retryInterval) clearInterval(retryInterval);

        let attempts = 0;
        retryInterval = setInterval(() => {
            attempts++;
            const success = trySort();
            if (success || attempts >= 20) {
                clearInterval(retryInterval);
                retryInterval = null;
            }
        }, 200);
    }

    // Observe SPA URL transitions
    let lastUrl = location.href;
    function checkUrlChange() {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            triggerSortWithRetry();
        }
    }

    const origPush = history.pushState;
    history.pushState = function () {
        origPush.apply(this, arguments);
        checkUrlChange();
    };

    const origReplace = history.replaceState;
    history.replaceState = function () {
        origReplace.apply(this, arguments);
        checkUrlChange();
    };

    window.addEventListener('popstate', checkUrlChange);

    // Initial run when DOM starts loading
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            triggerSortWithRetry();
            new MutationObserver(checkUrlChange).observe(document.body, { subtree: true, childList: true });
        });
    } else {
        triggerSortWithRetry();
        new MutationObserver(checkUrlChange).observe(document.body, { subtree: true, childList: true });
    }
})();